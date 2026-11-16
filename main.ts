// Token-radar entry for the make.fun token-radar-01 bounty (Node 22, standard library only).
//
// The program takes the sealed snapshot (a directory holding snapshot.json, or the file itself),
// scores every pre-token protocol with the category-calibrated model in lib/model.ts, and writes
// the ranked board to board.json plus the dashboard's data file data.js. It then copies this
// repository's dashboard/ and screenshots/ into the output directory, and finally writes
// dossier.json — the summary the judge reads — with the vendored make.fun library.
//
// The dashboard is a static page with no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js all read data.js, which this program writes from the
// same board the model produced. The model is what sets this entry apart: each protocol's
// multiple is the market's own median market-cap-to-TVL for its category, shrunk toward the
// global median, rather than a single flat house number.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The repository's own directory, so the dashboard and screenshots are found
// relative to this file no matter where the program is launched from.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>` in the arguments, else the fallback. */
function flagValue(name: string, fallback: string): string {
  const flag = `--${name}`;
  const spaced = process.argv.indexOf(flag);
  if (spaced !== -1 && spaced + 1 < process.argv.length) {
    return process.argv[spaced + 1]!;
  }
  for (const token of process.argv) {
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return fallback;
}

// Resolve the snapshot: a path ending in .json is the file itself, anything else
// is a directory holding snapshot.json.
const inputArg = flagValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

// The output directory: --output, else MAKEFUN_OUTPUT_DIR, else the grader's /output.
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// Score the snapshot, then refuse to write anything if the board would fail the gate.
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// The board and the dashboard's data, both derived from the same scored radar.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}

// The dashboard page goes over as-is; the screenshots are checked below.
copyFiles(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyFiles(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: DOSSIER_TEXT_CAP,
    screenshots: SHOT_LIMITS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
