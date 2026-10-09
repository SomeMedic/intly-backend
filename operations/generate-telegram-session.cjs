#!/usr/bin/env node
'use strict';

const { access, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Использование: node operations/generate-telegram-session.cjs [файл результата]');
    console.log('По умолчанию: .local/telegram-session.env в корне INTLY. Существующий файл не перезаписывается.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Запусти скрипт в обычном интерактивном терминале.');
  }

  const outputFile = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../../.local/telegram-session.env');
  try {
    await access(outputFile);
    throw new Error(`Файл уже существует: ${outputFile}. Укажи другой файл аргументом команды.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });

  const { TelegramClient } = require('teleproto');
  const { StringSession } = require('teleproto/sessions');
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => process.exit(130));
  async function ask(label, secret = false) {
    if (!secret) return (await rl.question(label)).trim();
    process.stdout.write(label);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  }

  let client;
  try {
    console.log('Вход в существующий Telegram-аккаунт для INTLY. Ctrl+C — отмена.');
    const apiIdText = await ask('Telegram API ID: ');
    const apiId = Number(apiIdText);
    if (!/^\d+$/.test(apiIdText) || !Number.isSafeInteger(apiId) || apiId <= 0) {
      throw new Error('API ID должен быть положительным целым числом.');
    }
    const apiHash = (await ask('Telegram API Hash (ввод скрыт): ', true)).trim();
    if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
      throw new Error('API Hash должен содержать 32 шестнадцатеричных символа.');
    }
    client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 3,
      deviceModel: 'INTLY Collector',
      appVersion: '1.0',
    });
    client.setLogLevel('none');
    await client.start({
      phoneNumber: () => ask('Номер аккаунта в международном формате (+7...): '),
      phoneCode: (_, info) => ask(
        info?.type === 'app' ? 'Код из служебного чата Telegram (ввод скрыт): ' : 'Код подтверждения (ввод скрыт): ',
        true,
      ).then((value) => value.trim()),
      password: () => ask('Пароль двухфакторной защиты (ввод скрыт): ', true),
      emailAddress: () => ask('Email для входа, который запросил Telegram: '),
      emailVerification: async () => ({
        type: 'code',
        code: (await ask('Код из письма Telegram (ввод скрыт): ', true)).trim(),
      }),
      onError: () => true,
    });
    if (!(await client.checkAuthorization())) throw new Error('Telegram не подтвердил авторизацию.');
    const session = client.session.save();
    if (!session) throw new Error('Не удалось получить строку сессии.');
    await writeFile(outputFile, `TELEGRAM_SESSION=${session}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Готово. Строка TELEGRAM_SESSION сохранена в: ${outputFile}`);
    console.log('Скопируй строку целиком в свой ENV. Сессию не отправляй в чат.');
  } finally {
    rl.close();
    if (client) await client.destroy();
  }
}

main().catch((error) => {
  const rpcCode = error.errorMessage;
  const message = typeof rpcCode === 'string' && /^[A-Z_]+(?:_\d+)?$/.test(rpcCode)
    ? rpcCode
    : error.message;
  console.error(`Не удалось создать сессию: ${message}`);
  process.exitCode = 1;
});
