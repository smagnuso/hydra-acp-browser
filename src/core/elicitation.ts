// Form elicitation (ACP elicitation/create, form mode): parsing the agent's
// structured questions into plain field descriptions a UI can lay out,
// validating the answers and building the reply.

import type { ElicitationEntry } from "./types.js";

export type ElicitationAction = "accept" | "decline" | "cancel";
export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationOption {
  value: string;
  title: string;
  description?: string;
}

export type ElicitationField =
  | {
      kind: "choice";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ElicitationOption[];
      default?: string;
    }
  | {
      kind: "multi";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ElicitationOption[];
      minItems?: number;
      maxItems?: number;
      default?: string[];
    }
  | {
      kind: "text";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      format?: string;
      default?: string;
    }
  | {
      kind: "number";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      integer: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      kind: "boolean";
      key: string;
      title: string;
      description?: string;
      required: boolean;
      default?: boolean;
    };

// Raw answers keyed by field key, as a form holds them before validation.
export type ElicitationDraft = Record<string, ElicitationValue | undefined>;

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function optionList(raw: unknown, titled: boolean): ElicitationOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ElicitationOption[] = [];
  for (const o of raw) {
    if (!titled) {
      if (typeof o === "string") {
        out.push({ value: o, title: o });
      }
      continue;
    }
    const r = asRec(o);
    const value = asStr(r?.const);
    if (!r || value === undefined) {
      continue;
    }
    const description = asStr(r.description);
    out.push({
      value,
      title: asStr(r.title) ?? value,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

function enumOptions(prop: Rec): ElicitationOption[] {
  const one = optionList(prop.oneOf, true);
  if (one.length > 0) {
    return one;
  }
  const names = Array.isArray(prop.enumNames) ? (prop.enumNames as unknown[]) : [];
  return optionList(prop.enum, false).map((o, i) => ({
    ...o,
    title: typeof names[i] === "string" ? (names[i] as string) : o.title,
  }));
}

function multiDefault(prop: Rec, options: ElicitationOption[]): { default?: string[] } {
  if (!Array.isArray(prop.default)) {
    return {};
  }
  const known = new Set(options.map((o) => o.value));
  const def = (prop.default as unknown[]).filter((v): v is string => typeof v === "string" && known.has(v));
  return def.length > 0 ? { default: def } : {};
}

function parseField(key: string, prop: Rec, required: boolean): ElicitationField | null {
  const title = asStr(prop.title) ?? key;
  const description = asStr(prop.description);
  const base = { key, title, required, ...(description ? { description } : {}) };
  switch (prop.type) {
    case "string": {
      const options = enumOptions(prop);
      if (options.length > 0) {
        const def = asStr(prop.default);
        return {
          kind: "choice",
          ...base,
          options,
          ...(def !== undefined && options.some((o) => o.value === def) ? { default: def } : {}),
        };
      }
      return {
        kind: "text",
        ...base,
        ...(asNum(prop.minLength) !== undefined ? { minLength: asNum(prop.minLength) } : {}),
        ...(asNum(prop.maxLength) !== undefined ? { maxLength: asNum(prop.maxLength) } : {}),
        ...(asStr(prop.pattern) ? { pattern: asStr(prop.pattern) } : {}),
        ...(asStr(prop.format) ? { format: asStr(prop.format) } : {}),
        ...(typeof prop.default === "string" ? { default: prop.default } : {}),
      };
    }
    case "number":
    case "integer":
      return {
        kind: "number",
        ...base,
        integer: prop.type === "integer",
        ...(asNum(prop.minimum) !== undefined ? { minimum: asNum(prop.minimum) } : {}),
        ...(asNum(prop.maximum) !== undefined ? { maximum: asNum(prop.maximum) } : {}),
        ...(asNum(prop.default) !== undefined ? { default: asNum(prop.default) } : {}),
      };
    case "boolean":
      return {
        kind: "boolean",
        ...base,
        ...(typeof prop.default === "boolean" ? { default: prop.default } : {}),
      };
    case "array": {
      const items = asRec(prop.items);
      const options = items
        ? items.anyOf !== undefined
          ? optionList(items.anyOf, true)
          : optionList(items.enum, false)
        : [];
      if (options.length === 0) {
        return null;
      }
      return {
        kind: "multi",
        ...base,
        options,
        ...(asNum(prop.minItems) !== undefined ? { minItems: asNum(prop.minItems) } : {}),
        ...(asNum(prop.maxItems) !== undefined ? { maxItems: asNum(prop.maxItems) } : {}),
        ...multiDefault(prop, options),
      };
    }
    default:
      return null;
  }
}

// Parses an elicitation/create request. Null when it is not form mode or
// declares no field this client can render; the caller then abstains.
export function parseElicitationRequest(
  requestId: string | number,
  params: Rec | undefined,
): ElicitationEntry | null {
  if (params?.mode !== undefined && params.mode !== "form") {
    return null;
  }
  const schema = asRec(params?.requestedSchema);
  const props = asRec(schema?.properties);
  if (!schema || !props) {
    return null;
  }
  const requiredKeys = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k) => typeof k === "string") : [],
  );
  const fields: ElicitationField[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const prop = asRec(raw);
    const field = prop ? parseField(key, prop, requiredKeys.has(key)) : null;
    if (field) {
      fields.push(field);
    }
  }
  if (fields.length === 0) {
    return null;
  }
  const hydraMeta = asRec(asRec(params?._meta)?.["hydra-acp"]);
  const elicitationId = asStr(hydraMeta?.elicitationId) ?? String(requestId);
  const title = asStr(schema.title);
  return {
    requestId,
    elicitationId,
    message: asStr(params?.message) ?? "",
    ...(title ? { title } : {}),
    fields,
  };
}

const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_INPUT = 10000;

function patternMatches(pattern: string, value: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH || value.length > MAX_PATTERN_INPUT) {
    return true;
  }
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) {
    return false;
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// Null when the value fits the format or the format is unknown (annotation only).
function formatError(format: string, v: string): string | null {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address";
    case "uri":
      try {
        const u = new URL(v);
        return u.protocol.length > 1 ? null : "Enter a valid URI";
      } catch {
        return "Enter a valid URI";
      }
    case "date":
      return validDate(v) ? null : "Enter a date as YYYY-MM-DD";
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v) &&
        validDate(v.slice(0, 10)) &&
        !Number.isNaN(Date.parse(v))
        ? null
        : "Enter a date and time like 2024-01-31T09:30:00Z";
    default:
      return null;
  }
}

// The answers a form starts with: every field's schema default.
export function elicitationDefaults(fields: ElicitationField[]): ElicitationDraft {
  const draft: ElicitationDraft = {};
  for (const f of fields) {
    if (f.default !== undefined) {
      draft[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
    }
  }
  return draft;
}

function isBlank(v: ElicitationValue | undefined): boolean {
  return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

// Per-field error messages for a draft; an empty object means it can be
// submitted. Optional fields left blank are valid and omitted from the reply.
export function validateElicitation(
  fields: ElicitationField[],
  draft: ElicitationDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (isBlank(v)) {
      if (f.required && f.default === undefined) {
        errors[f.key] = "Required";
      }
      continue;
    }
    if (f.kind === "multi" && Array.isArray(v)) {
      if (f.minItems !== undefined && v.length < f.minItems) {
        errors[f.key] = `Pick at least ${f.minItems}`;
      } else if (f.maxItems !== undefined && v.length > f.maxItems) {
        errors[f.key] = `Pick at most ${f.maxItems}`;
      }
    } else if (f.kind === "text" && typeof v === "string") {
      if (f.minLength !== undefined && v.length < f.minLength) {
        errors[f.key] = `At least ${f.minLength} characters`;
      } else if (f.maxLength !== undefined && v.length > f.maxLength) {
        errors[f.key] = `At most ${f.maxLength} characters`;
      } else if (f.pattern !== undefined && !patternMatches(f.pattern, v)) {
        errors[f.key] = "Does not match the expected format";
      } else if (f.format !== undefined) {
        const bad = formatError(f.format, v);
        if (bad) {
          errors[f.key] = bad;
        }
      }
    } else if (f.kind === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors[f.key] = "Enter a number";
      } else if (f.integer && !Number.isInteger(v)) {
        errors[f.key] = "Enter a whole number";
      } else if (f.minimum !== undefined && v < f.minimum) {
        errors[f.key] = `At least ${f.minimum}`;
      } else if (f.maximum !== undefined && v > f.maximum) {
        errors[f.key] = `At most ${f.maximum}`;
      }
    }
  }
  return errors;
}

// The JSON-RPC result for an answer. Blank optional fields are left out;
// a boolean with a schema default that was never touched sends the default.
export function elicitationResult(
  action: ElicitationAction,
  fields: ElicitationField[] = [],
  draft: ElicitationDraft = {},
): Record<string, unknown> {
  if (action !== "accept") {
    return { action };
  }
  const content: Record<string, ElicitationValue> = {};
  for (const f of fields) {
    let v = draft[f.key];
    if (v === undefined && f.default !== undefined) {
      v = f.default;
    }
    if (!isBlank(v)) {
      content[f.key] = v as ElicitationValue;
    }
  }
  return { action, content };
}

// A claude-acp "Other" companion: question_N_custom rides next to question_N.
export function customCompanionKey(key: string): string {
  return `${key}_custom`;
}

// Splits fields into the ones to lay out and, for each, its free-text
// companion (when the form has one), so a UI can show it under its question.
export function groupElicitationFields(
  fields: ElicitationField[],
): Array<{ field: ElicitationField; custom?: ElicitationField }> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Array<{ field: ElicitationField; custom?: ElicitationField }> = [];
  for (const f of fields) {
    if (f.key.endsWith("_custom") && byKey.get(f.key.slice(0, -"_custom".length))) {
      continue;
    }
    const custom = byKey.get(customCompanionKey(f.key));
    out.push({ field: f, ...(custom?.kind === "text" ? { custom } : {}) });
  }
  return out;
}
