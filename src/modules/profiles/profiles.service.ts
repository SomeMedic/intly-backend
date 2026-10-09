import { Injectable, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { JobsService } from '../jobs/jobs.service';
import { ProfileListQueryDto, UpdateProfileDto, UpsertProfileDto } from './dto/profile.dto';
import { DEFAULT_MATCH_WEIGHTS, Profile } from './schemas/profile.schema';
import { ProfilesRepository } from './profiles.repository';

@Injectable()
export class ProfilesService {
  constructor(
    private readonly profilesRepository: ProfilesRepository,
    @Optional() private readonly jobsService?: JobsService,
  ) {}

  async list(actor: Actor, query: ProfileListQueryDto = {}) {
    const userId = actor.role === 'Admin' && query.userId ? query.userId : actor.id;
    const profiles = await this.profilesRepository.listByUser(userId);
    return profiles.map((profile) => this.toPublicProfile(profile));
  }

  async get(actor: Actor, id: string) {
    const profile = await this.getAccessibleProfile(actor, id);
    return this.toPublicProfile(profile);
  }

  async create(actor: Actor, dto: UpsertProfileDto) {
    const existingProfiles = await this.profilesRepository.listByUser(actor.id);
    const shouldActivate = dto.isActive ?? existingProfiles.length === 0;
    if (shouldActivate) {
      await this.profilesRepository.clearActive(actor.id);
    }

    const created = await this.profilesRepository.create({
      ...this.normalizeDto(dto),
      userId: actor.id,
      isActive: shouldActivate,
    });
    await this.enqueueProfileIndex(created._id);
    return this.toPublicProfile(created);
  }

  async update(actor: Actor, id: string, dto: UpdateProfileDto) {
    const existing = await this.getAccessibleProfile(actor, id);
    if (dto.isActive) {
      await this.profilesRepository.clearActive(existing.userId);
    }
    const updated =
      actor.role === 'Admin'
        ? await this.profilesRepository.updateById(id, this.normalizeDto(dto, existing))
        : await this.profilesRepository.updateOwned(id, actor.id, this.normalizeDto(dto, existing));
    await this.enqueueProfileIndex(updated._id);
    return this.toPublicProfile(updated);
  }

  async duplicate(actor: Actor, id: string) {
    const original = await this.getAccessibleProfile(actor, id);
    const { _id: _sourceId, name, isActive: _isActive, createdAt: _createdAt, updatedAt: _updatedAt, ...copyable } = original as Profile & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const created = await this.profilesRepository.create({
      ...copyable,
      name: `${name} copy`,
      isActive: false,
    });
    await this.enqueueProfileIndex(created._id);
    return this.toPublicProfile(created);
  }

  async delete(actor: Actor, id: string): Promise<{ success: true }> {
    await this.getAccessibleProfile(actor, id);
    if (actor.role === 'Admin') {
      await this.profilesRepository.softDeleteById(id);
    } else {
      await this.profilesRepository.softDeleteOwned(id, actor.id);
    }
    await this.enqueueProfileDelete(id);
    return { success: true };
  }

  async setActive(actor: Actor, id: string) {
    const profile = await this.getAccessibleProfile(actor, id);
    const updated = await this.profilesRepository.setActive(id, profile.userId);
    await this.enqueueProfileIndex(updated._id);
    return this.toPublicProfile(updated);
  }

  async recalculateMatch(actor: Actor, id: string) {
    const profile = await this.getAccessibleProfile(actor, id);
    if (!this.jobsService) {
      throw new Error('Jobs service is not available');
    }
    const job = await this.jobsService.enqueue('analytics', 'profile.recalculateMatch', {
      profileId: profile._id,
      userId: profile.userId,
      requestedByUserId: actor.id,
    }, { jobId: `profile-recalculate:${profile._id}` });
    return { profileId: profile._id, job };
  }


  private toPublicProfile(profile: Profile): Omit<Profile, '_id'> & { id: string } {
    const publicProfile = toPublic(profile) as Omit<Profile, '_id'> & { id: string };
    return {
      ...publicProfile,
      compensationPreferences: this.recordOrEmpty(profile.compensationPreferences),
      aiPreferences: this.recordOrEmpty(profile.aiPreferences),
      matchWeights: this.matchWeightsOrDefault(profile.matchWeights),
    };
  }

  private recordOrEmpty(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  }

  private matchWeightsOrDefault(value: unknown) {
    const patch = this.recordOrEmpty(value);
    return Object.fromEntries(
      Object.entries({ ...DEFAULT_MATCH_WEIGHTS, ...patch }).filter(([, entry]) => entry !== undefined),
    ) as typeof DEFAULT_MATCH_WEIGHTS;
  }

  private async enqueueProfileIndex(profileId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'index-profile', { profileId }, { jobId: `search:profile:${profileId}` });
  }

  private async enqueueProfileDelete(profileId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'delete-profile', { profileId }, { jobId: `search:profile-delete:${profileId}` });
  }

  private normalizeDto(dto: UpsertProfileDto | UpdateProfileDto, existing?: Profile): Partial<Profile> {
    const { matchWeights, ...rest } = dto;
    return {
      ...rest,
      ...(matchWeights ? { matchWeights: { ...(existing?.matchWeights ?? DEFAULT_MATCH_WEIGHTS), ...matchWeights } } : {}),
    };
  }

  private async getAccessibleProfile(actor: Actor, id: string): Promise<Profile> {
    return actor.role === 'Admin' ? this.profilesRepository.getById(id) : this.profilesRepository.getOwned(id, actor.id);
  }
}
