#!/usr/bin/env node
'use strict';

/**
 * Release helper: sets the next version (JAAR.MMDD.N) and records the changelog.
 *
 *   node scripts/set-version.js "English text" "Nederlandse tekst"
 *   node scripts/set-version.js changelog.json      (object with one text per language code)
 *
 * - Version format JAAR.MMDD.N: MMDD is month and day as one number without a leading zero
 *   (10 Nov = 1110, 5 Jan = 105, semver allows no leading zeros); N counts releases that day from 0.
 * - Keeps app.json and package.json on the same version (and .homeycompose/app.json if present).
 * - Adds the entry (newest first) to .homeychangelog.json and rewrites CHANGELOG.md.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANGS = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
const VERSION_RE = /^(\d{4})\.(\d+)\.(\d+)$/;

const file = (p) => path.join(ROOT, p);
const readJson = (p) => JSON.parse(fs.readFileSync(file(p), 'utf8'));
const writeJson = (p, data) => fs.writeFileSync(file(p), `${JSON.stringify(data, null, 2)}\n`);

function nextVersion(current, date = new Date()) {
  const year = date.getFullYear();
  const mmdd = (date.getMonth() + 1) * 100 + date.getDate();
  const m = VERSION_RE.exec(current || '');
  const n = m && Number(m[1]) === year && Number(m[2]) === mmdd ? Number(m[3]) + 1 : 0;
  return `${year}.${mmdd}.${n}`;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function renderMarkdown(changelog) {
  const lines = ['# Changelog', ''];
  for (const [version, texts] of Object.entries(changelog)) {
    lines.push(`## ${version}`, '');
    const langs = [...LANGS.filter((l) => texts[l]), ...Object.keys(texts).filter((l) => !LANGS.includes(l))];
    for (const lang of langs) lines.push(`- **${lang}**: ${texts[lang]}`);
    lines.push('');
  }
  return lines.join('\n');
}

function readTexts(args) {
  if (args.length === 1 && args[0].endsWith('.json')) return JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  if (args.length >= 1) {
    const texts = { en: args[0] };
    if (args[1]) texts.nl = args[1];
    return texts;
  }
  throw new Error('Gebruik: node scripts/set-version.js "English" "Nederlands"  of  node scripts/set-version.js changelog.json');
}

function main() {
  const texts = readTexts(process.argv.slice(2));
  if (!texts.en) throw new Error('Een Engelse tekst ("en") is verplicht');

  const manifest = fs.existsSync(file('.homeycompose/app.json')) ? '.homeycompose/app.json' : 'app.json';
  const compose = readJson(manifest);
  const current = compose.version;
  const version = nextVersion(current);
  if (current && VERSION_RE.test(current) && compareVersions(version, current) <= 0) {
    throw new Error(`Nieuwe versie ${version} is niet hoger dan ${current}`);
  }

  compose.version = version;
  writeJson(manifest, compose);
  for (const p of ['app.json', 'package.json'].filter((x) => x !== manifest)) {
    if (fs.existsSync(file(p))) {
      const data = readJson(p);
      data.version = version;
      writeJson(p, data);
    }
  }

  const changelogPath = '.homeychangelog.json';
  const old = fs.existsSync(file(changelogPath)) ? readJson(changelogPath) : {};
  if (old[version]) throw new Error(`Versie ${version} staat al in de changelog`);
  const changelog = { [version]: texts, ...old };
  writeJson(changelogPath, changelog);
  fs.writeFileSync(file('CHANGELOG.md'), renderMarkdown(changelog));

  const missing = LANGS.filter((l) => !texts[l]);
  console.log(`Versie ${current || '-'} → ${version}`);
  if (missing.length) console.log(`Let op: geen changelogtekst voor ${missing.join(', ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { nextVersion, renderMarkdown, LANGS };
