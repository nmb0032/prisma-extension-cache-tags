/**
 * The script deliberately returns the raw cached string. The extension must
 * deserialize and verify that untrusted string before treating it as a hit.
 */
export const VERSIONED_LOOKUP_SCRIPT = `
local baseKey = ARGV[1]
local lockToken = ARGV[2]
local lockTtlMs = tonumber(ARGV[3]) or 0
local versions = {}
for index, versionKey in ipairs(KEYS) do
  versions[index] = redis.call("GET", versionKey) or "0"
end
local cacheKey = baseKey .. ":" .. table.concat(versions, ".")
local value = redis.call("GET", cacheKey)
if value then
  return { cacheKey, value, "1", "0" }
end

if lockToken ~= "" and lockTtlMs > 0 then
  local lockKey = cacheKey .. ":lock"
  local acquired = redis.call("SET", lockKey, lockToken, "NX", "PX", lockTtlMs)
  if acquired then
    value = redis.call("GET", cacheKey)
    if value then
      redis.call("DEL", lockKey)
      return { cacheKey, value, "1", "0" }
    end
    return { cacheKey, "", "0", "1" }
  end
end

return { cacheKey, "", "0", "0" }`;

export const versionedLookupScript = VERSIONED_LOOKUP_SCRIPT;
export const VERSIONED_LOOKUP_LUA = VERSIONED_LOOKUP_SCRIPT;
