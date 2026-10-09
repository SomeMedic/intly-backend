#!/usr/bin/env node
import 'dotenv/config';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

const required = ['MONGODB_URI', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key}`);
    process.exit(2);
  }
}
if (process.env.CONFIRM_PRODUCTION_BOOTSTRAP !== 'yes') {
  console.error('Refusing to bootstrap admin without CONFIRM_PRODUCTION_BOOTSTRAP=yes');
  process.exit(2);
}
if (process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
  console.error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  process.exit(2);
}

const email = process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Production Admin';
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
const users = mongoose.connection.collection('users');
const existing = await users.findOne({ email, deletedAt: { $exists: false } });
if (existing) {
  if (existing.role !== 'Admin' || existing.status !== 'Active') {
    console.error(`User ${email} already exists but is not an active Admin`);
    process.exitCode = 3;
  } else {
    console.log(`Admin already exists: ${email}`);
  }
  await mongoose.disconnect();
  process.exit();
}
const now = new Date();
await users.insertOne({
  _id: randomUUID(),
  email,
  name,
  role: 'Admin',
  status: 'Active',
  passwordHash: await argon2.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, { type: argon2.argon2id }),
  passwordChangedAt: now,
  mustChangePassword: true,
  locale: 'ru',
  timezone: process.env.BOOTSTRAP_ADMIN_TIMEZONE || 'Europe/Moscow',
  uiSettings: { theme: 'system', density: 'comfortable', reducedMotion: false },
  notificationSettings: { inApp: true, email: false, telegram: false, quietHours: null, digestMode: 'instant' },
  aiPreferences: {},
  onboarding: { minimumComplete: true, checklist: {} },
  telegram: { linked: false },
  createdAt: now,
  updatedAt: now,
});
console.log(`Created production admin: ${email}`);
await mongoose.disconnect();
