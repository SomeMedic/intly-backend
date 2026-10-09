import { ForbiddenException, Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { SavedView } from './schemas/saved-view.schema';
import { UpdateSavedViewDto, UpsertSavedViewDto } from './dto/saved-view.dto';
import { SavedViewsRepository } from './saved-views.repository';

@Injectable()
export class SavedViewsService {
  constructor(private readonly repository: SavedViewsRepository) {}

  async list(actor: Actor) {
    const views = actor.role === 'Admin' ? await this.repository.listAll() : await this.repository.listByUser(actor.id);
    return views.map((view) => toPublic(view));
  }

  async create(actor: Actor, dto: UpsertSavedViewDto) {
    if (dto.isDefault) await this.repository.clearDefault(actor.id, dto.scope);
    const created = await this.repository.create({
      ...this.toPatch(dto),
      userId: actor.id,
      query: dto.query ?? {},
      filters: dto.filters ?? {},
      sort: dto.sort ?? {},
      mode: dto.mode ?? 'list',
      visibleFields: dto.visibleFields ?? [],
      columnState: dto.columnState ?? {},
      isDefault: dto.isDefault ?? false,
      pinned: dto.pinned ?? false,
    });
    return toPublic(created);
  }

  async update(actor: Actor, id: string, dto: UpdateSavedViewDto) {
    const existing = await this.getAccessible(actor, id);
    const scope = dto.scope ?? existing.scope;
    if (dto.isDefault) {
      this.assertOwnsDefault(actor, existing);
      await this.repository.clearDefault(existing.userId, scope);
    }
    const updated = await this.repository.update(id, this.toPatch(dto));
    return toPublic(updated);
  }

  async duplicate(actor: Actor, id: string) {
    const existing = await this.getAccessible(actor, id);
    const { _id: _sourceId, deletedAt: _deletedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...copyable } = existing as SavedView & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const duplicated = await this.repository.create({
      ...copyable,
      userId: actor.id,
      name: `${existing.name} — копия`,
      isDefault: false,
    });
    return toPublic(duplicated);
  }

  async setDefault(actor: Actor, id: string) {
    const existing = await this.getAccessible(actor, id);
    this.assertOwnsDefault(actor, existing);
    await this.repository.clearDefault(existing.userId, existing.scope);
    const updated = await this.repository.update(id, { isDefault: true });
    return toPublic(updated);
  }

  async pin(actor: Actor, id: string) {
    const existing = await this.getAccessible(actor, id);
    const updated = await this.repository.update(id, { pinned: !existing.pinned });
    return toPublic(updated);
  }

  async delete(actor: Actor, id: string) {
    await this.getAccessible(actor, id);
    await this.repository.softDelete(id);
    return { success: true };
  }

  private async getAccessible(actor: Actor, id: string): Promise<SavedView> {
    const view = await this.repository.getById(id);
    if (actor.role !== 'Admin' && view.userId !== actor.id) {
      throw new ForbiddenException('Saved view access denied');
    }
    return view;
  }

  private assertOwnsDefault(actor: Actor, view: SavedView): void {
    if (view.userId !== actor.id) {
      throw new ForbiddenException('Only the saved view owner can set it as default');
    }
  }

  private toPatch(dto: UpsertSavedViewDto | UpdateSavedViewDto): Partial<SavedView> {
    return dto;
  }
}
