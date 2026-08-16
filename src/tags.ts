export function normalizeTags(tags: string[] | undefined, maxTags: number): string[] {
    if (!tags || tags.length === 0) {
        return [];
    }

    const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
    return uniqueTags.sort().slice(0, maxTags);
}
