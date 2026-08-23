import type { CacheScope } from './schema';

function encodeComponent(value: string): string {
    return encodeURIComponent(value);
}

export function scopeRootTag(scope: CacheScope): string {
    return `scope:${encodeComponent(scope.namespace)}:${encodeComponent(scope.id)}:root`;
}

export function scopeModelTag(scope: CacheScope, model: string): string {
    return `scope:${encodeComponent(scope.namespace)}:${encodeComponent(scope.id)}:model:${encodeComponent(model)}`;
}

export function scopeEntityTag(scope: CacheScope, model: string, identity: string): string {
    return `scope:${encodeComponent(scope.namespace)}:${encodeComponent(scope.id)}:entity:${encodeComponent(model)}:${encodeComponent(identity)}`;
}

export function globalModelTag(model: string): string {
    return `global:model:${encodeComponent(model)}`;
}

export function globalEntityTag(model: string, identity: string): string {
    return `global:entity:${encodeComponent(model)}:${encodeComponent(identity)}`;
}

export function normalizeTags(tags: readonly string[]): string[] {
    return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort();
}
