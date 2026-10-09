import { randomUUID } from 'node:crypto';

export const newId = () => randomUUID();
export const schemaOptions = {
  timestamps: true,
  versionKey: false as const,
  strict: 'throw' as const,
  toJSON: {
    transform: (_document: unknown, value: Record<string, unknown>) => {
      value.id = value._id;
      delete value._id;
      delete value.__v;
      return value;
    },
  },
};

export function toPublic<T extends { _id: string }>(value: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = value;
  return { ...rest, id: _id };
}
