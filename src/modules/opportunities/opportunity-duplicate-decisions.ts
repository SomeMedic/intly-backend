import { createHash } from 'node:crypto';

import type { DuplicateOpportunityFacts } from './opportunity-deduplication';
import { semanticDuplicateFactHash, semanticOpportunityFacts } from './opportunity-semantic-duplicates';

export type DuplicateDecisionSnapshot = {
  _id: string;
  leftId: string;
  rightId: string;
  leftHash: string;
  rightHash: string;
};

type OpportunityLike = DuplicateOpportunityFacts & { _id: string };

export function duplicateDecisionSnapshot(left: OpportunityLike, right: OpportunityLike): DuplicateDecisionSnapshot | null {
  const ordered = [left, right].sort((a, b) => a._id.localeCompare(b._id));
  const leftHash = semanticDuplicateFactHash(semanticOpportunityFacts(ordered[0]));
  const rightHash = semanticDuplicateFactHash(semanticOpportunityFacts(ordered[1]));
  if (!leftHash || !rightHash) return null;
  return {
    _id: `${ordered[0]._id}:${ordered[1]._id}`,
    leftId: ordered[0]._id,
    rightId: ordered[1]._id,
    leftHash,
    rightHash,
  };
}

export function duplicateReviewToken(reviewId: string, left: OpportunityLike, right: OpportunityLike): string | null {
  const snapshot = duplicateDecisionSnapshot(left, right);
  if (!snapshot) return null;
  return createHash('sha256')
    .update(JSON.stringify({ reviewId, pairKey: snapshot._id, leftHash: snapshot.leftHash, rightHash: snapshot.rightHash }))
    .digest('hex');
}
