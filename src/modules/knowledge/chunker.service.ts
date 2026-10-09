import { Injectable } from '@nestjs/common';

export type ChunkInput = { section: string; text: string };

@Injectable()
export class ChunkerService {
  chunk(text: string): ChunkInput[] {
    const sections = this.sections(text);
    const chunks: ChunkInput[] = [];
    for (const section of sections) {
      chunks.push(...this.chunkSection(section.title, section.text));
    }
    return chunks;
  }

  private sections(text: string): Array<{ title: string; text: string }> {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const sections: Array<{ title: string; text: string[] }> = [{ title: 'body', text: [] }];
    for (const line of lines) {
      if (line.length <= 80 && /^[\p{L}\p{N}\s/.,&+-]+$/u.test(line) && !/[.!?]$/.test(line)) {
        sections.push({ title: line.toLowerCase(), text: [] });
      } else {
        sections[sections.length - 1].text.push(line);
      }
    }
    return sections.map((section) => ({ title: section.title, text: section.text.join('\n') })).filter((section) => section.text);
  }

  private chunkSection(section: string, text: string): ChunkInput[] {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: ChunkInput[] = [];
    const target = 480;
    const overlap = 60;
    for (let offset = 0; offset < words.length; offset += target - overlap) {
      const slice = words.slice(offset, offset + target).join(' ').trim();
      if (slice) chunks.push({ section, text: slice });
      if (offset + target >= words.length) break;
    }
    return chunks.length ? chunks : [{ section, text }];
  }
}
