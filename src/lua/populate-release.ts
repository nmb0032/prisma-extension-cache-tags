export const POPULATE_RELEASE_SCRIPT = `
local cacheKey = KEYS[1]
local lockKey = cacheKey .. ":lock"
if redis.call("GET", lockKey) ~= ARGV[1] then
  return 0
end
redis.call("SET", cacheKey, ARGV[2], "EX", tonumber(ARGV[3]))
redis.call("DEL", lockKey)
return 1`;

export const populateAndReleaseScript = POPULATE_RELEASE_SCRIPT;
export const POPULATE_RELEASE_LUA = POPULATE_RELEASE_SCRIPT;
