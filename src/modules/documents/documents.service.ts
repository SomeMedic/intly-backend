import { Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { KnowledgeService } from '../knowledge';
import { ProfilesRepository } from '../profiles';

@Injectable()
export class DocumentsService {
  constructor(private readonly knowledgeService: KnowledgeService, private readonly profilesRepository: ProfilesRepository) {}

  async retrieveContext(actor: Actor, query: string, profileId?: string, topK?: number, profileOwnerUserId?: string) {
    const retrievalActor = actor.role === 'Admin' && profileOwnerUserId
      ? { id: profileOwnerUserId, email: actor.email, role: 'User' as const }
      : actor;
    const [retrieval, profile] = await Promise.all([
      this.knowledgeService.retrieveForActor(retrievalActor, query, profileId, topK),
      profileId
        ? actor.role === 'Admin' ? this.profilesRepository.getById(profileId) : this.profilesRepository.getOwned(profileId, actor.id)
        : this.profilesRepository.findActive(retrievalActor.id),
    ]);
    return {
      profile: profile
        ? {
            id: profile._id,
            name: profile.name,
            kind: profile.kind,
            targetRoles: profile.targetRoles,
            seniority: profile.seniority,
            technologies: profile.technologies,
            compensationPreferences: profile.compensationPreferences,
            locations: profile.locations,
            remotePreferences: profile.remotePreferences,
            employmentTypes: profile.employmentTypes,
            summary: profile.structuredExperienceSummary,
          }
        : null,
      alwaysInclude: retrieval.alwaysInclude,
      evidence: retrieval.evidence,
    };
  }

  reprocess(documentId: string) {
    return this.knowledgeService.processDocument(documentId);
  }
}
