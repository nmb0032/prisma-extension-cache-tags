import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {
    readonly path: string;
    readonly reason: string;

    constructor(path: string, reason: string) {
        super(`Cannot canonicalize value at ${path}: ${reason}`);
        this.name = 'CanonicalizationError';
        this.path = path;
        this.reason = reason;
    }
}

function propertyPath(path: string, key: string): string {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        return `${path}.${key}`;
    }

    const escapedKey = key.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    return `${path}['${escapedKey}']`;
}

function encodeString(value: string): string {
    return `${value.length}:${value}`;
}

function encodeBytes(value: Uint8Array): string {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
}

function unsupported(path: string, type: string): never {
    throw new CanonicalizationError(path, `${type} is unsupported`);
}

function writeValue(value: unknown, path: string, active: WeakMap<object, string>, output: string[]): void {
    if (value === null) {
        output.push('null;');
        return;
    }

    switch (typeof value) {
        case 'undefined':
            output.push('undefined;');
            return;
        case 'string':
            output.push(`string:${encodeString(value)};`);
            return;
        case 'boolean':
            output.push(value ? 'boolean:true;' : 'boolean:false;');
            return;
        case 'number':
            if (Number.isNaN(value)) {
                output.push('number:NaN;');
            } else if (value === Number.POSITIVE_INFINITY) {
                output.push('number:+Infinity;');
            } else if (value === Number.NEGATIVE_INFINITY) {
                output.push('number:-Infinity;');
            } else if (Object.is(value, -0)) {
                output.push('number:-0;');
            } else {
                output.push(`number:${String(value)};`);
            }
            return;
        case 'bigint':
            output.push(`bigint:${value.toString()};`);
            return;
        case 'function':
            unsupported(path, 'function');
        case 'symbol':
            unsupported(path, 'symbol');
        default:
            break;
    }

    const objectValue = value as object;
    const previousPath = active.get(objectValue);
    if (previousPath !== undefined) {
        throw new CanonicalizationError(path, `cycle detected via ${path} (already seen at ${previousPath})`);
    }
    active.set(objectValue, path);

    try {
        if (value instanceof Date) {
            const timestamp = value.getTime();
            output.push(`date:${Number.isNaN(timestamp) ? 'invalid' : encodeString(value.toISOString())};`);
            return;
        }

        if (Buffer.isBuffer(value)) {
            output.push(`buffer:${encodeString(encodeBytes(value))};`);
            return;
        }

        if (value instanceof ArrayBuffer) {
            output.push(`arraybuffer:${encodeString(encodeBytes(new Uint8Array(value)))};`);
            return;
        }

        if (ArrayBuffer.isView(value)) {
            const view = value as ArrayBufferView;
            const constructorName = value.constructor.name;
            output.push(`typedarray:${encodeString(constructorName)}:${encodeString(encodeBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))};`);
            return;
        }

        if (value instanceof WeakMap) {
            unsupported(path, 'WeakMap');
        }
        if (value instanceof WeakSet) {
            unsupported(path, 'WeakSet');
        }

        if (value instanceof Map) {
            const entries: string[] = [];
            for (const [key, child] of value.entries()) {
                const encodedKey: string[] = [];
                const encodedValue: string[] = [];
                writeValue(key, `${path}.<map-key>`, active, encodedKey);
                writeValue(child, `${path}.<map-value>`, active, encodedValue);
                entries.push(`${encodedKey.join('')}${encodedValue.join('')}`);
            }
            entries.sort();
            output.push(`map:${entries.length}[${entries.join('')}]`);
            return;
        }

        if (value instanceof Set) {
            const entries: string[] = [];
            for (const child of value.values()) {
                const encoded: string[] = [];
                writeValue(child, `${path}.<set-value>`, active, encoded);
                entries.push(encoded.join(''));
            }
            entries.sort();
            output.push(`set:${entries.length}[${entries.join('')}]`);
            return;
        }

        if (Array.isArray(value)) {
            output.push(`array:${value.length}[`);
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    output.push('hole;');
                    continue;
                }
                writeValue(value[index], `${path}[${index}]`, active, output);
            }
            output.push(']');
            return;
        }

        const toJSON = (value as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === 'function') {
            let jsonValue: unknown;
            try {
                jsonValue = toJSON.call(value);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new CanonicalizationError(path, `toJSON() failed: ${message}`);
            }
            const encoded: string[] = [];
            writeValue(jsonValue, `${path}.toJSON()`, active, encoded);
            output.push(`decimal:${encoded.join('')}`);
            return;
        }
        if (typeof toJSON === 'symbol') {
            unsupported(propertyPath(path, 'toJSON'), 'symbol');
        }

        const symbolKeys = Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
        if (symbolKeys.length > 0) {
            unsupported(`${path}[${String(symbolKeys[0])}]`, 'symbol key');
        }

        const keys = Object.keys(value).sort();
        output.push(`object:${keys.length}{`);
        for (const key of keys) {
            output.push(`key:${encodeString(key)}=`);
            writeValue((value as Record<string, unknown>)[key], propertyPath(path, key), active, output);
        }
        output.push('}');
    } finally {
        active.delete(objectValue);
    }
}

export function canonicalizePrismaValue(value: unknown): string {
    const output: string[] = [];
    writeValue(value, '$', new WeakMap<object, string>(), output);
    return output.join('');
}

export function hashCanonicalValue(value: unknown): string {
    return createHash('sha256').update(canonicalizePrismaValue(value)).digest('hex');
}
