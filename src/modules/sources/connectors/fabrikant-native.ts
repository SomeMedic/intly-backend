import { load } from 'cheerio';

export const FABRIKANT_ORIGIN = 'https://www.fabrikant.ru';
export const FABRIKANT_PAGE_LIMIT = 40;
export type FabrikantPartition = { day: string; sectionId?: string; page: number; status: 'pending' | 'complete' | 'capped'; total?: number; pages?: number; ids: string[]; pageSignatures: string[] };
export type FabrikantCard = { id: string; url: string; procedureNumber: string; lotNumber?: string; nativeCatalogNumberText?: string; nativeNoticeNumber?: string; title: string; text: string; nativeBadges?: string[]; nativeStatus?: string; section?: string; organizer?: string; publishedText?: string; deadlineText?: string; priceText?: string; participationText?: string };
export type FabrikantCatalog = { cards: FabrikantCard[]; total?: number; pages: number; empty: boolean; sectionIds: string[]; reflectedFilters: Record<string, unknown> };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

export function fabrikantListUrl(partition: Pick<FabrikantPartition, 'day' | 'sectionId' | 'page'>): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(partition.day) || !Number.isSafeInteger(partition.page) || partition.page < 1 || partition.page > 100 || partition.sectionId !== undefined && !/^[1-9]\d*$/.test(partition.sectionId)) throw new Error('Invalid Fabrikant native partition');
  const url = new URL('/procedure/search', FABRIKANT_ORIGIN);
  url.searchParams.set('date_publication_from', partition.day);
  url.searchParams.set('date_publication_to', partition.day);
  if (partition.sectionId) url.searchParams.append('section_ids[]', partition.sectionId);
  url.searchParams.set('page_limit', String(FABRIKANT_PAGE_LIMIT));
  url.searchParams.set('page_number', String(partition.page));
  return url.toString();
}

export function fabrikantDetailUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !(url.hostname === 'fabrikant.ru' || url.hostname.endsWith('.fabrikant.ru'))) throw new Error('Fabrikant detail URL is outside the public source');
  url.hash = '';
  if (url.hostname === 'fabrikant.ru') url.hostname = 'www.fabrikant.ru';
  const native = /^\/v2\/trades\/procedure\/view\/[\w-]+\/?$/.test(url.pathname) || /^\/(?:44|223)\/procedure\/[\w-]+\/\d+\/?$/.test(url.pathname) || url.pathname.startsWith('/trades/') && url.searchParams.get('action') === 'view' && /^\d+$/.test(url.searchParams.get('id') ?? '') || url.hostname === 'market.fabrikant.ru' && /^\/purchase_notice(?:_es)?\/view\/?$/.test(url.pathname) && url.searchParams.size === 1 && /^[a-z0-9]+$/.test(url.searchParams.get('id') ?? '');
  if (!native) throw new Error('Fabrikant card does not link to a native procedure detail');
  return url.toString();
}

/** BSON null represents missing optional evidence; required native identity remains strict. */
export function fabrikantStoredCard(input: unknown): FabrikantCard {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fabrikant pending native card is invalid');
  const card = { ...input } as Record<string, unknown>;
  const optionalStrings = ['lotNumber', 'nativeCatalogNumberText', 'nativeNoticeNumber', 'nativeStatus', 'section', 'organizer', 'publishedText', 'deadlineText', 'priceText', 'participationText'];
  for (const field of [...optionalStrings, 'nativeBadges']) if (card[field] === null) delete card[field];
  if (typeof card.id !== 'string' || !/^[1-9]\d*$/.test(card.id) || typeof card.procedureNumber !== 'string' || !/^\d+$/.test(card.procedureNumber) || typeof card.title !== 'string' || !card.title || typeof card.text !== 'string' || typeof card.url !== 'string') throw new Error('Fabrikant pending native card is invalid');
  if (optionalStrings.some(field => card[field] !== undefined && typeof card[field] !== 'string') || card.lotNumber !== undefined && !/^[1-9]\d*$/.test(String(card.lotNumber)) || card.nativeBadges !== undefined && (!Array.isArray(card.nativeBadges) || card.nativeBadges.some(value => typeof value !== 'string'))) throw new Error('Fabrikant pending native card optional evidence is invalid');
  fabrikantDetailUrl(card.url);
  return card as FabrikantCard;
}

/** Read literal JSON chunks only. Never evaluate shipped scripts or React references. */
function nativeObjects(html: string): Record<string, unknown>[] {
  const $ = load(html);
  let stream = '';
  $('script').each((_, node) => {
    const text = $(node).text();
    if (!text.startsWith('self.__next_f.push(')) return;
    try { const chunk = JSON.parse(text.slice(19, -1)); if (chunk[0] === 1 && typeof chunk[1] === 'string') stream += chunk[1]; } catch { /* Other scripts are not bootstrap data. */ }
  });
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 100) return;
    if (!Array.isArray(value)) objects.push(value as Record<string, unknown>);
    if (objects.length > 100_000) throw new Error('Fabrikant native bootstrap exceeded structural limit');
    Object.values(value).forEach(child => visit(child, depth + 1));
  };
  for (const row of stream.split('\n')) {
    const text = row.slice(row.indexOf(':') + 1);
    if (!/^[{[]/.test(text)) continue;
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; }
    visit(value, 0);
  }
  return objects;
}

export function parseFabrikantCatalog(html: string, finalUrl: string, partition: Pick<FabrikantPartition, 'day' | 'sectionId' | 'page'>): FabrikantCatalog {
  const expected = new URL(fabrikantListUrl(partition));
  const final = new URL(finalUrl);
  if (final.origin !== expected.origin || final.pathname !== expected.pathname || JSON.stringify([...final.searchParams].sort()) !== JSON.stringify([...expected.searchParams].sort())) throw new Error('Fabrikant catalog redirected to different filters/page');
  const objects = nativeObjects(html);
  const wanted: Record<string, unknown> = { date_publication_from: partition.day, date_publication_to: partition.day, page_limit: '40', page_number: String(partition.page), ...(partition.sectionId ? { section_ids: [partition.sectionId] } : {}) };
  const comparable = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const echoes = objects.filter(value => value.searchParams && typeof value.searchParams === 'object').map(value => value.searchParams as Record<string, unknown>);
  if (!echoes.length || echoes.some(value => comparable(value) !== comparable(wanted))) throw new Error('Fabrikant native reflected filters do not match requested scope');
  const sectionIds = new Set<string>();
  for (const object of objects) {
    if (!Array.isArray(object.success)) continue;
    for (const direction of object.success) {
      if (!direction || typeof direction !== 'object' || !Array.isArray(direction.sections) || !Number.isInteger(direction.procedure_direction_code)) continue;
      for (const section of direction.sections) if (Number.isSafeInteger(section?.section_id) && section.section_id > 0 && typeof section.section_name === 'string') sectionIds.add(String(section.section_id));
    }
  }
  if (!sectionIds.size || partition.sectionId && !sectionIds.has(partition.sectionId)) throw new Error('Fabrikant catalog has no matching native section taxonomy');
  const $ = load(html);
  $('script,style,svg').remove();
  const cards: FabrikantCard[] = [];
  $('[data-slot="card"][data-id]').each((_, node) => {
    const card = $(node);
    const id = card.attr('data-id') ?? '';
    const anchor = card.find('a[data-slot="anchor"]').filter((_, a) => { try { return new URL($(a).attr('href') ?? '', finalUrl).hostname.endsWith('fabrikant.ru'); } catch { return false; } }).first();
    const text = normalize(card.text());
    const header = card.children().first();
    const numberNodes = header.find('span').filter((_, e) => $(e).children().length === 0 && /^№\s*\d+(?:\s*-\s*[1-9]\d*)?$/.test(normalize($(e).text())));
    const nativeCatalogNumberText = normalize(numberNodes.text());
    const number = numberNodes.length === 1 ? /^№\s*(\d+)(?:\s*-\s*([1-9]\d*))?$/.exec(nativeCatalogNumberText) : null;
    const noticeNumbers = header.find('a[data-slot="anchor"][href]').map((_, e) => {
      const value = normalize($(e).text());
      const noticeUrl = new URL($(e).attr('href')!, finalUrl);
      return noticeUrl.hostname === 'zakupki.gov.ru' && /^\d+$/.test(value) && noticeUrl.searchParams.get('searchString') === value ? value : undefined;
    }).get().filter((value): value is string => typeof value === 'string');
    const title = normalize(anchor.text());
    if (!/^[1-9]\d*$/.test(id) || !number || !title) throw new Error('Fabrikant catalog has an unrecognized native lot identity/title');
    const value = (label: string) => card.find('[data-slot="text"]').filter((_, e) => normalize($(e).text()) === label).first().next('[data-slot="text"]').text().trim() || undefined;
    const badges = card.find('[data-slot="badge"]').map((_, e) => normalize($(e).text())).get();
    const procedureBadges = badges.filter(value => value !== 'МСП');
    cards.push({ id, procedureNumber: number[1], lotNumber: number[2], nativeCatalogNumberText, nativeNoticeNumber: noticeNumbers.length === 1 ? noticeNumbers[0] : undefined, title, text, url: fabrikantDetailUrl(new URL(anchor.attr('href') ?? '', finalUrl).toString()), nativeBadges: badges, nativeStatus: procedureBadges[0], section: procedureBadges[1], organizer: value('Организатор'), publishedText: value('Дата публикации'), deadlineText: value('Дата окончания приёма заявок'), priceText: normalize(card.find('[data-slot="text"].font-heading').text()) || undefined, participationText: normalize(card.find('a[data-slot="button"]').text()) || undefined });
  });
  if (new Set(cards.map(card => card.id)).size !== cards.length || cards.length > 40) throw new Error('Fabrikant catalog repeats lot IDs or exceeds native page limit');
  const paginations = objects.filter(value => (value.keys as Record<string, unknown> | undefined)?.page === 'page_number' && (value.keys as Record<string, unknown>)?.limit === 'page_limit');
  const signatures = new Set(paginations.map(value => `${value.total}:${value.pages}`));
  if (cards.length) {
    if (signatures.size !== 1 || !paginations.length) throw new Error('Fabrikant catalog has missing/ambiguous native pagination');
    const { total, pages } = paginations[0];
    if (!Number.isSafeInteger(total) || Number(total) < cards.length || !Number.isSafeInteger(pages) || Number(pages) < partition.page || Number(pages) > 100 || Number($('.rc-pagination-item-active').attr('title')) !== partition.page) throw new Error('Fabrikant native count/current page is invalid');
    if (Number(pages) > Math.ceil(Number(total) / 40) || partition.page < Number(pages) && cards.length !== 40) throw new Error('Fabrikant native pagination disagrees with returned lots');
    return { cards, total: Number(total), pages: Number(pages), empty: false, sectionIds: [...sectionIds], reflectedFilters: wanted };
  }
  const positiveEmpty = $('div').filter((_, e) => $(e).children().length === 0 && normalize($(e).text()) === 'По вашему запросу ничего не найдено').length > 0;
  if (!positiveEmpty || partition.page !== 1 || paginations.some(value => Number(value.total) !== 0)) throw new Error('Fabrikant no-card response is not a verified native empty result');
  return { cards, pages: 0, total: 0, empty: true, sectionIds: [...sectionIds], reflectedFilters: wanted };
}

export function fabrikantPublished(text?: string): Date | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text ?? '');
  if (!match) return undefined;
  const iso = `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+03:00`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return undefined;
  const moscow = new Date(date.getTime() + 10_800_000).toISOString();
  return moscow.slice(0, 19) === iso.slice(0, 19) ? date : undefined;
}

export function fabrikantDay(iso: string): string { return new Date(Date.parse(iso) + 10_800_000).toISOString().slice(0, 10); }

/** Only a complete native amount + ISO currency label is numeric evidence. */
export function fabrikantBudget(text?: string): { originalText?: string; amount?: number; currency?: string; kind: string } {
  if (!text || /^(?:Цена не указана|Без указания цены)$/i.test(text.trim())) return { originalText: text, kind: 'unpublished-lot-price' };
  const match = /^(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,](\d{1,2}))?\s+([A-Z]{3})$/.exec(text.trim());
  if (!match) return { originalText: text, kind: 'published-native-price-text' };
  const numericText = `${match[1].replace(/[ \u00a0\u202f]/g, '').replace(/^0+(?=\d)/, '')}${match[2] ? `.${match[2]}` : ''}`;
  const amount = Number(numericText);
  if (!Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER || amount.toFixed(match[2]?.length ?? 0) !== numericText) return { originalText: text, kind: 'published-native-price-text' };
  return { originalText: text, amount, currency: match[3], kind: amount === 0 ? 'published-zero-lot-price' : 'published-initial-lot-price' };
}

/** Recover a concatenated old ordinal only from a native lot heading and its dedicated EIS label. */
export function fabrikantLotNumber(card: FabrikantCard, nativeDetailText?: string): string | undefined {
  const text = normalize(nativeDetailText ?? '');
  const ordinal = /^Лот\s*№\s*([1-9]\d*)\./.exec(text)?.[1];
  const notices = [...text.matchAll(/(?:^|\s)Номер закупки в ЕИС\s+(\d+)(?=\s|$)/g)];
  return ordinal && notices.length === 1 && card.lotNumber === ordinal + notices[0][1] ? ordinal : card.lotNumber;
}

/** Pure retained-card mapping; optional retained detail evidence never mutates the original raw card. */
export function fabrikantTenderMetadata(card: FabrikantCard, nativeDetailText?: string) {
  const budget = fabrikantBudget(card.priceText);
  const deadlineAt = fabrikantPublished(card.deadlineText);
  const lotNumber = fabrikantLotNumber(card, nativeDetailText);
  return {
    tenderData: {
      contractNumber: card.procedureNumber, procedureNumber: card.procedureNumber, numberLabel: 'Номер процедуры',
      ...(lotNumber ? { lotNumber } : {}), ...(lotNumber !== card.lotNumber ? { catalogLotNumber: card.lotNumber, lotNumberEvidence: 'native-lot-heading-and-eis-number' } : {}), platform: 'Фабрикант', section: card.section,
      organizer: card.organizer, nativeStatus: card.nativeStatus, priceText: card.priceText, priceKind: budget.kind,
      deadlineText: card.deadlineText, publishedText: card.publishedText,
    },
    budget, deadlineAt: deadlineAt?.toISOString(), deadlineText: card.deadlineText,
    deadlinePrecision: deadlineAt ? 'minute' : 'unknown', deadlineTimezone: deadlineAt ? 'Europe/Moscow' : undefined,
  };
}

/** A missing lot is resumable only through a link published by this verified procedure page. */
export class FabrikantLotPageError extends Error {
  constructor(readonly nextPageUrl: string, readonly pageSignature: string) {
    super('Fabrikant detail does not contain the catalog lot number on this native page');
    this.name = 'FabrikantLotPageError';
  }
}

export function fabrikantDetail(card: FabrikantCard, html: string, finalUrl = card.url): { text: string; publication?: Date; publishedText?: string; precision?: string; nativeStatus?: string; kind: string; lotSpecific: boolean } | null {
  const $ = load(html);
  $('script,style,svg,nav,footer').remove();
  const text = normalize($('body').text());
  const url = new URL(fabrikantDetailUrl(card.url));
  if (url.pathname.startsWith('/v2/trades/procedure/view/')) {
    if (!card.lotNumber) throw new Error('Fabrikant v2 detail requires a catalog lot number');
    if (!new RegExp(`(?:№|Номер\\s*:?)[\\s]*${card.procedureNumber}(?:\\D|$)`).test(text)) throw new Error('Fabrikant detail procedure number differs from its catalog lot');
    const current = new URL(fabrikantDetailUrl(finalUrl));
    const pageNumber = (candidate: URL) => {
      if (candidate.origin !== url.origin || candidate.pathname !== url.pathname || candidate.username || candidate.password || candidate.hash || candidate.search && (candidate.searchParams.size !== 1 || !/^[1-9]\d*$/.test(candidate.searchParams.get('page') ?? ''))) throw new Error('Fabrikant native lot pagination changes procedure identity or query');
      const page = Number(candidate.searchParams.get('page') ?? '1');
      if (!Number.isSafeInteger(page)) throw new Error('Fabrikant native lot pagination page is invalid');
      return page;
    };
    const page = pageNumber(current);
    const paginations = $('ul.pagination');
    let nextPageUrl: string | undefined;
    if (paginations.length) {
      if (paginations.toArray().some(e => $(e).find('li.active').length !== 1)) throw new Error('Fabrikant native lot pagination has missing/ambiguous active page markers');
      const active = new Set(paginations.find('li.active').map((_, e) => normalize($(e).text())).get());
      if (active.size !== 1 || !active.has(String(page))) throw new Error('Fabrikant native lot pagination current page differs from requested page');
      const next = new Set<string>();
      paginations.find('a[href]').each((_, e) => {
        const candidate = new URL($(e).attr('href')!, current);
        const number = pageNumber(candidate);
        const label = normalize($(e).text());
        if (/^\d+$/.test(label) && label !== String(number)) throw new Error('Fabrikant native lot pagination link label differs from its page');
        if (number === page + 1) next.add(candidate.toString());
      });
      if (next.size > 1) throw new Error('Fabrikant native lot pagination has ambiguous next links');
      nextPageUrl = [...next][0];
    } else if (page !== 1) throw new Error('Fabrikant paginated lot detail has no native current-page evidence');
    const markers = $('[data-lot-idc]');
    const lotNumbers = new Set<string>();
    const nativeIds = new Set<string>();
    markers.each((_, e) => {
      const number = /^Лот\s*№\s*([1-9]\d*)\./.exec(normalize($(e).text()))?.[1];
      const id = $(e).attr('data-lot-idc') ?? '';
      if (!number || !/^[\w-]+$/.test(id) || !$(e).hasClass('panel-heading') || lotNumbers.has(number) || nativeIds.has(id)) throw new Error('Fabrikant detail has ambiguous native lot markers');
      lotNumbers.add(number);
      nativeIds.add(id);
    });
    const lot = markers.filter((_, e) => {
      const ordinal = /^Лот\s*№\s*([1-9]\d*)\./.exec(normalize($(e).text()))![1];
      if (ordinal === card.lotNumber) return true;
      const panel = $(e).closest('.panel');
      const label = panel.find('.panel-group-element-external_oos_number_url .col-md-4').filter((_, label) => normalize($(label).text()) === 'Номер закупки в ЕИС');
      if (label.length !== 1) return false;
      const value = label.next('.col-md-8');
      const notice = normalize(value.text());
      const anchor = value.find('a[href]');
      if (!/^\d+$/.test(notice) || anchor.length !== 1) return false;
      const noticeUrl = new URL(anchor.attr('href')!, current);
      return noticeUrl.protocol === 'https:' && noticeUrl.hostname === 'zakupki.gov.ru' && noticeUrl.searchParams.get('searchString') === notice && card.lotNumber === ordinal + notice && fabrikantLotNumber(card, normalize(panel.text())) === ordinal;
    }).closest('.panel');
    if (!lot.length) {
      if (markers.length && nextPageUrl) throw new FabrikantLotPageError(nextPageUrl, [...nativeIds].join(','));
      throw new Error('Fabrikant detail does not contain the catalog lot number');
    }
    if (lot.length !== 1) throw new Error('Fabrikant detail has ambiguous matching lot panels');
    const epoch = Number($('input[name="date_publication"]').attr('value'));
    const publishedText = normalize($('.panel-group-element-date_publication .col-md-8').text()) || undefined;
    const publication = Number.isSafeInteger(epoch) && epoch > 0 ? new Date(epoch * 1000) : fabrikantPublished(publishedText);
    return { text: normalize(lot.text()), publication, publishedText, precision: Number.isSafeInteger(epoch) && epoch > 0 ? 'second' : 'minute', nativeStatus: normalize(lot.find('.kim-state-label').first().text()) || undefined, kind: 'native-v2-procedure-lot', lotSpecific: true };
  }
  if (/^\/(?:44|223)\/procedure\//.test(url.pathname)) {
    const notice = url.pathname.split('/').filter(Boolean).at(-1)!;
    if (!$('h1').text().includes(notice) || !$('#common-info').length) throw new Error('Fabrikant regulated detail has no matching native notice identity');
    const match = /Дата и время публикации извещения\s*(\d{2}\.\d{2}\.\d{4})\s*•?\s*(\d{2}:\d{2}(?::\d{2})?)/.exec(text);
    const publishedText = match ? `${match[1]} ${match[2]}` : undefined;
    const nativeStatus = $('[data-slot="badge"]').map((_, e) => normalize($(e).text())).get().find(value => /при[её]м заявок|отмен|заверш|подведени|рассмотрени/i.test(value));
    return { text: normalize($('main').text()) || text, publication: fabrikantPublished(publishedText), publishedText, precision: 'minute', nativeStatus, kind: 'native-regulated-procedure', lotSpecific: card.lotNumber === '1' };
  }
  if (url.pathname.startsWith('/trades/')) {
    if (text.includes('\uFFFD') || !new RegExp(`№\\s*${card.procedureNumber}(?:\\D|$)`).test(text)) throw new Error('Fabrikant legacy detail has no decoded matching procedure identity');
    const match = /Дата публикации\s*:\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/.exec(text);
    return { text, publication: fabrikantPublished(match?.[1]), publishedText: match?.[1], precision: 'minute', kind: 'native-legacy-procedure', lotSpecific: false };
  }
  return null;
}
