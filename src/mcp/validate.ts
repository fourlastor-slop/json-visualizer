/**
 * Checking a tool's arguments against its input schema. Only the part of JSON Schema that
 * the tool definitions use is understood, and the complaints are written for the model
 * that made the call: they say what to change.
 */

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** Arguments that do not fit the schema. The message is meant to be shown to the caller. */
export class ArgumentError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function range(what: string, min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${what} between ${min} and ${max}`;
  return min !== undefined ? `${what} of at least ${min}` : `${what} of at most ${max}`;
}

function check(schema: JsonSchema, value: unknown, name: string): unknown {
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ArgumentError(`${name} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}; got ${JSON.stringify(value)}.`);
  }
  switch (schema.type) {
    case 'object': {
      if (!isObject(value)) throw new ArgumentError(`${name} must be an object.`);
      const properties = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
        if (unknown !== undefined) {
          const known = Object.keys(properties);
          throw new ArgumentError(`\`${unknown}\` is not a parameter of this tool. ${known.length > 0 ? `Its parameters are: ${known.join(', ')}.` : 'It takes no parameters.'}`);
        }
      }
      const checked: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties)) {
        const given = value[key];
        // An optional parameter passed as null is one that was left out.
        if (given === undefined || given === null) {
          if (schema.required?.includes(key)) throw new ArgumentError(`\`${key}\` is required.`);
          if (property.default !== undefined) checked[key] = property.default;
        } else {
          checked[key] = check(property, given, `\`${key}\``);
        }
      }
      return checked;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new ArgumentError(`${name} must be a list.`);
      if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) {
        throw new ArgumentError(`${name} must have ${range('a number of items', schema.minItems, schema.maxItems)}; it has ${value.length}.`);
      }
      const items = schema.items;
      return items ? value.map((item, i) => check(items, item, `${name.replace(/`$/, '')}[${i}]\``)) : value;
    }
    case 'string': {
      if (typeof value !== 'string') throw new ArgumentError(`${name} must be text.`);
      if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) {
        throw new ArgumentError(value.length === 0 ? `${name} must not be empty.` : `${name} must have ${range('a length', schema.minLength, schema.maxLength)} characters; it has ${value.length}.`);
      }
      return value;
    }
    case 'integer':
    case 'number': {
      const whole = schema.type === 'integer';
      const what = whole ? 'a whole number' : 'a number';
      if (typeof value !== 'number' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) throw new ArgumentError(`${name} must be ${what}.`);
      if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
        throw new ArgumentError(`${name} must be ${range(what, schema.minimum, schema.maximum)}; got ${value}.`);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new ArgumentError(`${name} must be true or false.`);
      return value;
    default:
      return value;
  }
}

/** The arguments with defaults filled in. Throws an ArgumentError naming what is wrong. */
export function checkArguments(schema: JsonSchema, value: unknown): Record<string, unknown> {
  return check(schema, value ?? {}, 'The arguments') as Record<string, unknown>;
}
