import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const API_BASE = (process.env.OPENNOTEBOOK_API_URL || 'http://localhost:5055').replace(/\/+$/, '');
const PASSWORD = process.env.OPENNOTEBOOK_PASSWORD;

function getHeaders(extra = {}) {
  const headers = {
    Accept: 'application/json',
    ...extra,
  };
  if (PASSWORD) {
    headers.Authorization = `Bearer ${PASSWORD}`;
  }
  return headers;
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, {
    ...options,
    headers: getHeaders(options.headers),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenNotebook API error ${response.status} at ${path}: ${errorText || response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

export async function checkStatus() {
  try {
    const data = await request('/health');
    return { ok: true, url: API_BASE, status: data };
  } catch (healthErr) {
    try {
      const notebooks = await request('/api/notebooks');
      return { ok: true, url: API_BASE, notebooksCount: Array.isArray(notebooks) ? notebooks.length : 0 };
    } catch (err) {
      return { ok: false, url: API_BASE, error: err.message };
    }
  }
}

export async function listNotebooks() {
  return request('/api/notebooks');
}

export async function createNotebook(name, description = '') {
  return request('/api/notebooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
}

export async function pushDocument(filePath, notebookId, docTitle) {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, 'utf8');
  const title = docTitle || basename(filePath, extname(filePath));

  const payload = {
    type: 'text',
    title,
    content,
    notebooks: notebookId ? [notebookId] : [],
  };

  return request('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function pushDirectory(dirPath, notebookId) {
  const root = resolve(dirPath);
  const results = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.markdown'))) {
        try {
          const res = await pushDocument(fullPath, notebookId);
          results.push({ file: fullPath, success: true, res });
        } catch (err) {
          results.push({ file: fullPath, success: false, error: err.message });
        }
      }
    }
  }

  await walk(root);
  return results;
}

export async function pullNotes(notebookId, outputDir = './opennotebook-notes') {
  const path = notebookId ? `/api/notes?notebook_id=${encodeURIComponent(notebookId)}` : '/api/notes';
  const notes = await request(path);
  if (!Array.isArray(notes)) {
    throw new Error('Unexpected notes response: not an array');
  }

  const targetDir = resolve(outputDir);
  await mkdir(targetDir, { recursive: true });

  const written = [];
  for (const note of notes) {
    const safeTitle = (note.title || 'untitled-note')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note';
    const filename = `${safeTitle}-${(note.id || '').replace(/[^a-z0-9]/gi, '').slice(-6)}.md`;
    const dest = join(targetDir, filename);

    const markdown = [
      '---',
      `title: "${(note.title || 'Untitled').replace(/"/g, '\\"')}"`,
      `opennotebook_id: "${note.id || ''}"`,
      `note_type: "${note.note_type || 'human'}"`,
      `created: "${note.created || ''}"`,
      `updated: "${note.updated || ''}"`,
      '---',
      '',
      `# ${note.title || 'Untitled Note'}`,
      '',
      note.content || '',
      '',
    ].join('\n');

    await writeFile(dest, markdown, 'utf8');
    written.push({ id: note.id, file: dest, title: note.title });
  }

  return written;
}

export async function searchOpenNotebook(query, limit = 20) {
  return request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, type: 'text', limit }),
  });
}

export async function chatOpenNotebook(notebookId, message) {
  return request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notebook_id: notebookId,
      message,
    }),
  });
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`OpenKnowledge <-> OpenNotebook Bridge

Usage:
  node scripts/opennotebook-bridge.mjs <command> [arguments]

Commands:
  status                                 Verify connectivity to OpenNotebook API
  list-notebooks                         List all notebooks in OpenNotebook
  create-notebook <name> [description]   Create a new notebook
  push-doc <filePath> <notebookId>       Push a Markdown file to OpenNotebook as a source
  push-dir <dirPath> <notebookId>        Push all Markdown files in a folder into a notebook
  pull-notes <notebookId> [outputDir]    Pull notes from a notebook into OpenKnowledge markdown files
  search <query> [limit]                 Full-text search OpenNotebook knowledge base
  chat <notebookId> <question>           Ask a question grounded in the notebook sources

Environment variables:
  OPENNOTEBOOK_API_URL   Default: http://localhost:5055
  OPENNOTEBOOK_PASSWORD  Optional password if auth is enabled
`);
    return;
  }

  try {
    switch (command) {
      case 'status': {
        const result = await checkStatus();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case 'list-notebooks': {
        const notebooks = await listNotebooks();
        console.log(JSON.stringify(notebooks, null, 2));
        break;
      }
      case 'create-notebook': {
        const [name, description] = args;
        if (!name) throw new Error('Missing notebook name');
        const res = await createNotebook(name, description);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'push-doc': {
        const [filePath, notebookId, docTitle] = args;
        if (!filePath || !notebookId) throw new Error('Usage: push-doc <filePath> <notebookId> [docTitle]');
        const res = await pushDocument(filePath, notebookId, docTitle);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'push-dir': {
        const [dirPath, notebookId] = args;
        if (!dirPath || !notebookId) throw new Error('Usage: push-dir <dirPath> <notebookId>');
        const res = await pushDirectory(dirPath, notebookId);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'pull-notes': {
        const [notebookId, outputDir] = args;
        const res = await pullNotes(notebookId, outputDir);
        console.log(`Successfully pulled ${res.length} note(s) to ${outputDir || './opennotebook-notes'}:`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'search': {
        const query = args.join(' ');
        if (!query) throw new Error('Missing search query');
        const res = await searchOpenNotebook(query);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'chat': {
        const [notebookId, ...msgParts] = args;
        const message = msgParts.join(' ');
        if (!notebookId || !message) throw new Error('Usage: chat <notebookId> <message>');
        const res = await chatOpenNotebook(notebookId, message);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  cli();
}
