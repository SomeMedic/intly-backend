import { ConflictException, NotFoundException } from '@nestjs/common';
import { Connection, mongo } from 'mongoose';

/** Serialize private writes with canonical merging so no new state is left on a merged alias. */
export async function withCanonicalOpportunity<T>(connection: Connection, opportunityId: string, write: (id: string, session: mongo.ClientSession) => Promise<T>): Promise<T> {
  const session = await connection.startSession();
  try {
    const result = await session.withTransaction(async () => {
      let id = opportunityId;
      const visited = new Set<string>();
      const collection = connection.db!.collection<{ _id: string; mergedIntoOpportunityId?: string; privateReferenceRevision?: number }>('opportunities');
      for (let hop = 0; hop < 20; hop += 1) {
        if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
        visited.add(id);
        const record = await collection.findOne({ _id: id }, { session, projection: { _id: 1, mergedIntoOpportunityId: 1 } });
        if (!record) throw new NotFoundException('Opportunity not found');
        if (record.mergedIntoOpportunityId) { id = record.mergedIntoOpportunityId; continue; }
        await collection.updateOne({ _id: id, mergedIntoOpportunityId: { $exists: false } }, { $inc: { privateReferenceRevision: 1 } }, { session });
        return { value: await write(id, session) };
      }
      throw new ConflictException('Opportunity alias chain exceeds safe depth');
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    if (!result) throw new ConflictException('Private opportunity write did not commit');
    return result.value;
  } finally { await session.endSession(); }
}
