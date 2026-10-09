import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';

import { assertPublicHttpUrl } from './url-safety';

type ResolvedAddress = { address: string; family: 4 | 6 };

export async function createPinnedDispatcher(url: URL): Promise<Agent> {
  await assertPublicHttpUrl(url);
  const resolved = await resolvePublicAddresses(url);
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname !== url.hostname) {
          callback(new Error('Pinned DNS hostname mismatch'), undefined as never, undefined as never);
          return;
        }
        if (options?.all) {
          callback(null, resolved.map((item) => ({ ...item })) as never, undefined as never);
          return;
        }
        const first = resolved[0];
        callback(null, first.address, first.family);
      },
    },
  });
}

export async function resolvePublicAddresses(url: URL): Promise<ResolvedAddress[]> {
  await assertPublicHttpUrl(url);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('URL host did not resolve');
  const publicAddresses: ResolvedAddress[] = [];
  for (const address of addresses) {
    const resolvedUrl = new URL(url.toString());
    resolvedUrl.hostname = address.family === 6 ? `[${address.address}]` : address.address;
    await assertPublicHttpUrl(resolvedUrl);
    publicAddresses.push({ address: address.address, family: address.family as 4 | 6 });
  }
  return publicAddresses;
}
