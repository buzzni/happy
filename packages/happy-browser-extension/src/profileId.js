/**
 * A fresh install's profile name defaults to a random suffix, not the bare
 * string "default". BrowserBridge treats a reconnect under the same profile
 * name as "replace the old socket" (browserBridge.ts) — two Chrome profiles
 * that both never touch the options page's profile field would otherwise
 * both save "default" and keep evicting each other's connection.
 */
export function generateDefaultProfileName(suffix = randomHex4()) {
    return `default-${suffix}`
}

function randomHex4() {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 4)
}
