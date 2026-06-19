/**
 * DorkBuilder — resolves named dork recipes into executable search URLs.
 *
 * Recipes are loaded from a JSON file you supply. Each recipe is a named
 * template with a `{domain}` placeholder and optional additional variables.
 *
 * Usage:
 *   const url = buildDork('indexed_pages', 'example.com', {}, recipeFilePath);
 *   // → https://www.google.com/search?q=site%3Aexample.com&num=10
 *
 *   const url = buildDork('intitle_phrase', 'example.com', { phrase: 'buy now' }, recipeFilePath);
 *   // → https://www.google.com/search?q=site%3Aexample.com+intitle%3A%22buy+now%22&num=10
 *
 * Recipe file format (JSON):
 *   {
 *     "version": 1,
 *     "description": "My search recipes",
 *     "recipes": {
 *       "indexed_pages": {
 *         "description": "All indexed pages for a domain",
 *         "template": "site:{domain}",
 *         "output_signal": "result_count"
 *       }
 *     }
 *   }
 */

import { readFileSync } from 'node:fs';

// ── Recipe types ──────────────────────────────────────────────────────────────

export interface DorkRecipe {
  description:    string;
  template:       string;
  output_signal:  'result_count' | 'url_patterns';
  variables?:     string[];   // additional template variables beyond {domain}
  notes?:         string;
}

export interface DorkRecipeFile {
  version:     number;
  description: string;
  recipes:     Record<string, DorkRecipe>;
}

// ── Recipe loader (cached after first load per path) ──────────────────────────

const _cache = new Map<string, DorkRecipeFile>();

function loadRecipes(recipeFilePath: string): DorkRecipeFile {
  const cached = _cache.get(recipeFilePath);
  if (cached) return cached;
  const raw = readFileSync(recipeFilePath, 'utf-8');
  const parsed = JSON.parse(raw) as DorkRecipeFile;
  _cache.set(recipeFilePath, parsed);
  return parsed;
}

/** Clears the recipe cache — useful in tests or when hot-reloading recipes. */
export function clearRecipeCache(): void {
  _cache.clear();
}

// ── Core builder ──────────────────────────────────────────────────────────────

/**
 * Resolves a named recipe into a search URL.
 *
 * @param recipeName      Key from the recipe file.
 * @param domain          Target domain (e.g. "example.com"). May be empty for
 *                        recipes that don't use {domain}.
 * @param variables       Optional substitutions for {variable} placeholders
 *                        beyond {domain} (e.g. { phrase: 'buy now' }).
 * @param recipeFilePath  Path to the recipes JSON file.
 * @param engine          Search engine to target. Defaults to 'google'.
 * @param numResults      Number of results to request. Defaults to 10.
 */
export function buildDork(
  recipeName:      string,
  domain:          string,
  variables:       Record<string, string> = {},
  recipeFilePath:  string,
  engine:          'google' | 'bing' = 'google',
  numResults       = 10,
): string {
  const recipes = loadRecipes(recipeFilePath);
  const recipe  = recipes.recipes[recipeName];

  if (!recipe) {
    const available = Object.keys(recipes.recipes).join(', ');
    throw new Error(
      `Unknown dork recipe "${recipeName}". Available: ${available}`,
    );
  }

  let query = recipe.template.replace(/\{domain\}/g, domain);

  for (const [key, value] of Object.entries(variables)) {
    query = query.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  const unresolved = query.match(/\{[a-z_]+\}/g);
  if (unresolved) {
    throw new Error(
      `Unresolved placeholders in dork "${recipeName}": ${unresolved.join(', ')}. ` +
      `Provide values via the variables argument.`,
    );
  }

  if (engine === 'google') {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${numResults}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${numResults}`;
}

/**
 * Returns all recipe names and descriptions from the recipe file.
 */
export function listRecipes(recipeFilePath: string): Array<{
  name:          string;
  description:   string;
  output_signal: string;
  has_variables: boolean;
}> {
  const recipes = loadRecipes(recipeFilePath);
  return Object.entries(recipes.recipes).map(([name, recipe]) => ({
    name,
    description:   recipe.description,
    output_signal: recipe.output_signal,
    has_variables: (recipe.variables?.length ?? 0) > 0,
  }));
}
