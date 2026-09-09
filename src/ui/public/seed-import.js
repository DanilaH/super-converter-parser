const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['txt', 'csv', 'json']);

function parseSeedContent(fileName, rawContent) {
  const name = String(fileName ?? '').trim();
  const content = String(rawContent ?? '');
  const extension = extensionOf(name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('Unsupported seed file. Use .txt, .csv, or .json.');
  }

  let keywords;
  if (extension === 'txt') keywords = parseTextKeywords(content);
  else if (extension === 'csv') keywords = parseCsvKeywords(content);
  else keywords = parseJsonKeywords(content);

  if (keywords.length === 0) throw new Error('Seed file contains no non-empty keywords.');
  return {
    version: 1,
    fileName: name,
    format: extension,
    keywords,
    keywordText: keywords.join('\n'),
  };
}

function parseCsvKeywords(content) {
  const rows = parseCsvRows(stripBom(String(content ?? '')));
  const nonEmpty = rows.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length < 2) throw new Error('CSV seed file must contain a header and at least one data row.');
  const header = nonEmpty[0];
  const keywordIndex = header.findIndex((column) => column.trim().toLowerCase() === 'keyword');
  if (keywordIndex < 0) {
    throw new Error(`CSV seed file must have a "keyword" column. Found: ${header.map((value) => `"${value}"`).join(', ')}.`);
  }

  const keywords = [];
  for (let index = 1; index < nonEmpty.length; index += 1) {
    const row = nonEmpty[index];
    const keyword = String(row[keywordIndex] ?? '').trim();
    if (!keyword) throw new Error(`CSV seed file row ${index + 1} has an empty "keyword" value.`);
    keywords.push(keyword);
  }
  return keywords;
}

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (quoted) throw new Error('CSV seed file has an unterminated quoted field.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseJsonKeywords(content) {
  let value;
  try {
    value = JSON.parse(stripBom(String(content ?? '')));
  } catch {
    throw new Error('JSON seed file is not valid JSON.');
  }

  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.keywords)
      ? value.keywords
      : null;
  if (items === null) {
    throw new Error('JSON seed file must be an array of strings or an object with a "keywords" string array.');
  }

  return items.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`JSON seed keyword at index ${index} must be a non-empty string.`);
    }
    return item.trim();
  });
}

function parseTextKeywords(content) {
  return stripBom(String(content ?? ''))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

if (typeof document !== 'undefined') installSeedImportEnhancer();

function installSeedImportEnhancer() {
  const observer = new MutationObserver(() => enhanceSeedInputs());
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceSeedInputs();
}

function enhanceSeedInputs() {
  const candidates = [
    ...document.querySelectorAll('.research-form textarea'),
    ...document.querySelectorAll('.batch-form textarea.batch-textarea'),
  ];
  for (const textarea of candidates) enhanceTextarea(textarea);
}

function enhanceTextarea(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.seedImportEnhanced === 'true') return;
  textarea.dataset.seedImportEnhanced = 'true';

  const zone = document.createElement('div');
  zone.className = 'seed-import-zone';
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.setAttribute('aria-label', 'Import seed keywords from TXT, CSV, or JSON');

  const copy = document.createElement('div');
  copy.className = 'seed-import-copy';
  const title = document.createElement('strong');
  title.textContent = 'Drop seed file here';
  const status = document.createElement('span');
  status.textContent = 'TXT lines · CSV keyword column · JSON string array / { keywords: [] }';
  copy.append(title, status);

  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'button compact';
  choose.textContent = 'Choose file';
  const input = document.createElement('input');
  input.type = 'file';
  input.className = 'seed-import-input';
  input.accept = '.txt,.csv,.json,text/plain,text/csv,application/json';

  choose.addEventListener('click', (event) => {
    event.stopPropagation();
    input.click();
  });
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void importFile(file, textarea, zone, title, status);
    input.value = '';
  });
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'dragend']) {
    zone.addEventListener(eventName, () => zone.classList.remove('dragging'));
  }
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void importFile(file, textarea, zone, title, status);
  });

  zone.append(copy, choose, input);
  textarea.insertAdjacentElement('afterend', zone);
}

async function importFile(file, textarea, zone, title, status) {
  zone.classList.remove('error');
  title.textContent = `Reading ${file.name}…`;
  status.textContent = 'Importing locally in this browser.';
  try {
    if (file.size > MAX_SEED_FILE_BYTES) throw new Error('Seed file is larger than 2 MB.');
    const parsed = parseSeedContent(file.name, await file.text());
    const current = textarea.value.trimEnd();
    textarea.value = current ? `${current}\n${parsed.keywordText}` : parsed.keywordText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    title.textContent = `${parsed.fileName}: ${parsed.keywords.length} imported`;
    status.textContent = `Added ${parsed.format.toUpperCase()} keywords to the editor. Preview will apply canonical normalization.`;
  } catch (error) {
    zone.classList.add('error');
    title.textContent = 'Could not import seed file';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
