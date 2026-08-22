export const BUMP_VERSIONS_SCRIPT = `
local ttlSeconds = tonumber(ARGV[1])
local versions = {}
for index, key in ipairs(KEYS) do
  versions[index] = redis.call("INCR", key)
  redis.call("EXPIRE", key, ttlSeconds)
end
return versions`;

export const bumpVersionsScript = BUMP_VERSIONS_SCRIPT;
export const BUMP_VERSIONS_LUA = BUMP_VERSIONS_SCRIPT;
