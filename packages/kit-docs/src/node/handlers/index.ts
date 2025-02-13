import { createFilter, type FilterPattern } from '@rollup/pluginutils';
import type { RequestHandler } from '@sveltejs/kit';
import { readFileSync } from 'fs';
import { globbySync } from 'globby';
import kleur from 'kleur';
import path from 'path';

import {
  createMarkdownParser,
  getFrontmatter,
  type MarkdownParser,
  type ParsedMarkdownResult,
  parseMarkdown,
} from '../markdown-plugin/parser';
import { readDirDeepSync, sortOrderedFiles } from '../utils/fs';
import { kebabToTitleCase } from '../utils/string';
import { isString } from '../utils/unit';

const CWD = process.cwd();
const ROUTES_DIR = path.resolve(CWD, 'src/routes');

let parser: MarkdownParser;

const restParamsRE = /\[\.\.\.(.*?)\]/g;
const restPropsRE = /\[\.\.\.(.*?)\]/;
const deepMatchRE = /\[\.\.\..*?_deep\]/;
const layoutNameRE = /@.+/g;
const defaultIncludeRE = /\.(md|svelte)($|\?)/;

export type HandleMetaRequestOptions = {
  filter?: (file: string) => boolean;
  resolve?: FileResolver;
  transform?: MetaTransform;
};

export type FileResolver = (
  slug: string,
  helpers: { resolve: typeof resolveSlug },
) =>
  | string
  | void
  | null
  | undefined
  | { file: string; transform: MetaTransform }
  | Promise<string | void | null | undefined | { file: string; transform: MetaTransform }>;

export type MetaTransform = (
  data: { slug: string; filePath: string } & ParsedMarkdownResult,
) => void | Promise<void>;

/**
 * Careful this function will throw if it can't match the `slug` param to a file.
 */
export async function handleMetaRequest(slugParam: string, options: HandleMetaRequestOptions = {}) {
  const { filter, resolve, transform } = options;

  const slug = paramToSlug(slugParam);
  const resolution = (await resolve?.(slug, { resolve: resolveSlug })) ?? resolveSlug(slug);

  const resolvedFile = isString(resolution) ? resolution : resolution?.file;
  const resolvedTransform = isString(resolution) ? null : resolution?.transform;

  if (!resolvedFile) {
    throw Error('Could not find file.');
  }

  if (filter && !filter(`/${cleanFilePath(resolvedFile)}`)) {
    return null;
  }

  const filePath = path.isAbsolute(resolvedFile) ? resolvedFile : path.resolve(CWD, resolvedFile);
  const content = readFileSync(filePath).toString();

  if (!parser) {
    parser = await createMarkdownParser();
  }

  const result = parseMarkdown(parser, content, filePath);
  await (resolvedTransform ?? transform)?.({ slug, filePath, ...result });
  return result;
}

export type CreateMetaRequestHandlerOptions = {
  include?: FilterPattern;
  exclude?: FilterPattern;
  debug?: boolean;
} & HandleMetaRequestOptions;

export function createMetaRequestHandler(
  options: CreateMetaRequestHandlerOptions = {},
): RequestHandler {
  const { include, exclude, debug, ...handlerOptions } = options;

  const filter = createFilter(include ?? defaultIncludeRE, exclude);

  return async ({ params }) => {
    try {
      const res = await handleMetaRequest(params.slug, { filter, ...handlerOptions });

      if (!res) {
        return { body: null };
      }

      return { body: res.meta as any };
    } catch (e) {
      if (debug) {
        console.log(kleur.bold(kleur.red(`\n[kit-docs]: failed to handle meta request.`)));
        console.log(`\n\n${e}\n`);
      }
    }

    return { body: null };
  };
}

const headingRE = /#\s(.*?)($|\n|\r)/;

export type HandleSidebarRequestOptions = {
  filter?: (file: string) => boolean;
  resolveTitle?: SidebarMetaResolver;
  resolveCategory?: SidebarMetaResolver;
  resolveSlug?: SidebarMetaResolver;
  formatCategoryName?: (name: string, helpers: { format: (name: string) => string }) => string;
};

export type SidebarMetaResolver = (data: {
  filePath: string;
  relativeFilePath: string;
  cleanFilePath: string;
  dirname: string;
  cleanDirname: string;
  frontmatter: Record<string, any>;
  fileContent: string;
  resolve: () => string;
}) => string | void | null | undefined | Promise<string | void | null | undefined>;

/**
 * Careful this function will throw if it can't match the `dir` param to a directory.
 */
export async function handleSidebarRequest(
  dirParam: string,
  options: HandleSidebarRequestOptions = {},
) {
  const { filter, formatCategoryName, resolveTitle, resolveCategory, resolveSlug } = options;

  const directory = paramToDir(dirParam);
  const dirPath = path.resolve(ROUTES_DIR, directory);

  const filePaths = sortOrderedFiles(readDirDeepSync(dirPath));

  const links: Record<string, { title: string; slug: string; match?: 'deep' }[]> = {};

  // Root at top.
  links['.'] = [];
  let hasRoot = false;

  for (const filePath of filePaths) {
    const filename = path.basename(filePath);
    const relativeFilePath = path.relative(ROUTES_DIR, filePath);
    const dirs = path.dirname(relativeFilePath).split('/');
    const cleanPath = cleanFilePath(filePath);
    const cleanDirs = path.dirname(cleanPath).split('/');
    const cleanDirsReversed = cleanDirs.slice().reverse();
    const isIndexFile = /\/index\./.test(cleanPath);
    const isRoot = cleanDirs.length === 1;

    let isDeepMatch = false;
    let isValidDeepMatch = false;

    if (deepMatchRE.test(relativeFilePath)) {
      const deepMatchDir = dirs.findIndex((dir) => deepMatchRE.test(dir));
      isDeepMatch = deepMatchDir >= 0;

      const glob = (depth: number) =>
        `src/routes/*${cleanDirs.slice(0, depth).join('/*')}/*index*.{md,svelte}`;

      let file = isDeepMatch ? globbySync(glob(deepMatchDir + 1))?.[0] : null;

      if (isDeepMatch && !file) {
        file = isDeepMatch ? globbySync(glob(deepMatchDir + 2))?.[0] : null;
      }

      isValidDeepMatch = isDeepMatch ? file === `src/routes/${relativeFilePath}` : false;
    }

    if (
      filename.startsWith('_') ||
      filename.startsWith('.') ||
      (isRoot && isIndexFile) ||
      (isDeepMatch && !isValidDeepMatch) ||
      !(filter?.(`/${cleanPath}`) ?? true)
    ) {
      continue;
    }

    const fileContent = readFileSync(filePath).toString();
    const frontmatter = getFrontmatter(fileContent);

    const resolverData = {
      filePath,
      relativeFilePath,
      cleanFilePath: cleanPath,
      frontmatter,
      fileContent,
      dirname: path.dirname(filePath),
      cleanDirname: path.dirname(cleanPath),
    };

    const categoryFormatter = formatCategoryName ?? kebabToTitleCase;

    const formatCategory = (dirname: string) =>
      categoryFormatter(dirname, { format: (name) => kebabToTitleCase(name) });

    const resolveDefaultTitle = () =>
      frontmatter.sidebar_title ??
      frontmatter.title ??
      (isDeepMatch ? formatCategory(cleanDirsReversed[0]) : null) ??
      fileContent.match(headingRE)?.[1] ??
      kebabToTitleCase(path.basename(cleanPath, path.extname(cleanPath)));

    const resolveDefaultCategory = () =>
      isRoot ? '.' : cleanDirsReversed[isIndexFile && isDeepMatch ? 1 : 0];

    const resolveDefaultSlug = () =>
      `/${cleanPath.replace(path.extname(cleanPath), '').replace(/\/index$/, '')}`;

    const category = formatCategory(
      (await resolveCategory?.({ ...resolverData, resolve: resolveDefaultCategory })) ??
        resolveDefaultCategory(),
    );

    const title =
      (await resolveTitle?.({ ...resolverData, resolve: resolveDefaultTitle })) ??
      resolveDefaultTitle();

    const slug =
      (await resolveSlug?.({ ...resolverData, resolve: resolveDefaultSlug })) ??
      resolveDefaultSlug();

    const match = isDeepMatch ? 'deep' : undefined;

    (links[category] ??= []).push({ title, slug, match });
    if (!hasRoot) hasRoot = category === '.';
  }

  if (!hasRoot) {
    delete links['.'];
  }

  return { links };
}

export type CreateSidebarRequestHandlerOptions = {
  include?: FilterPattern;
  exclude?: FilterPattern;
  debug?: boolean;
} & HandleSidebarRequestOptions;

export function createSidebarRequestHandler(
  options: CreateSidebarRequestHandlerOptions = {},
): RequestHandler {
  const { include, debug, exclude, ...handlerOptions } = options;

  const filter = createFilter(include ?? defaultIncludeRE, exclude);

  return async ({ params }) => {
    try {
      const { links } = await handleSidebarRequest(params.dir, {
        filter,
        ...handlerOptions,
      });

      return { body: { links } };
    } catch (e) {
      if (debug) {
        console.log(kleur.bold(kleur.red(`\n[kit-docs]: failed to handle sidebar request.`)));
        console.log(`\n\n${e}\n`);
      }
    }

    return { body: null };
  };
}

/**
 * Attempts to resolve the given slug to a file in the `routes` directory. This function returns
 * a relative file path.
 */
export function resolveSlug(slug: string): string | null {
  const fileGlobBase = `src/routes/${slug
    .split('/')
    .slice(0, -1)
    .map((s) => `*${s}`)
    .join('/')}`;

  const glob = `${fileGlobBase}/*${path.basename(slug)}*.{md,svelte}`;
  let file = globbySync(glob)?.[0];

  if (!file) {
    const glob = `${fileGlobBase}/*${path.basename(slug)}/*index*.{md,svelte}`;
    file = globbySync(glob)?.[0];
  }

  if (!file) {
    return null;
  }

  const matchedSlug = file
    .replace(restParamsRE, '')
    .replace(layoutNameRE, '')
    .replace(path.extname(file), '')
    .replace(/\/index$/, slug === 'index' ? '/index' : '');

  if (matchedSlug !== `src/routes/${slug}` || !file.endsWith('.md')) {
    return null;
  }

  return file;
}

/**
 * Takes an absolute or relative file path and maps it to a relative path to `src/routes`, and
 * strips out rest params and layout ids `{[...1]}index{@layout-id}.md`.
 *
 * @example `src/routes/docs/[...1getting-started]/[...1]intro.md` = `src/routes/docs/getting-started/intro.md`
 */
export function cleanFilePath(filePath: string) {
  const relativePath = path.isAbsolute(filePath) ? path.relative(ROUTES_DIR, filePath) : filePath;
  return relativePath.replace(restParamsRE, '').replace(layoutNameRE, path.extname(filePath));
}

export function paramToSlug(param: string) {
  return param.replace(/_/g, '/').replace(/\.html/, '');
}

export function paramToDir(param: string) {
  return paramToSlug(param);
}
