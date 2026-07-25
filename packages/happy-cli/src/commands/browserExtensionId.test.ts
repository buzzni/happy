import { describe, it, expect } from 'vitest'
import { computeChromeExtensionId } from './browserExtensionId'

describe('computeChromeExtensionId', () => {
    it('derives the fixed extension id Chrome assigns for a given manifest "key"', () => {
        // Known vector: this is the actual public key committed in
        // happy-browser-extension/manifest.json's "key" field, and the id
        // Chrome assigned when loading that extension (verified against a
        // real Chrome load, not just self-consistency).
        const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw4/QXXAxDB0tHkqpx6vYyNtZK2DJ+oRjFFjud9JJauEaLTN1Fvqam7j7olEHlkGKe0LprwuQ1sHyFb1sftTA5XmIfagdyttJiq6fuIlhE7yndjNL87Ly7klncBvKIxqCSycJ8a55zI0DeHnTWNoz8IhN8WLqOXe5scMdqKIKQ7VVJMlvBHYqJiq7XXP6mC3LTbXFm2NkennmH/5K+4sSILuVCB1CRsLY7sP5VtqzNyY7LvW0GS2uKN5/qaVm9hfmps1nk++dfM4u8voFvsW+MQQVvZZfYxXL0772O/tn1UYMiB66xZ9IIej2CGeq6Le88ulnIG7zPEIJkzFQtBZJ3QIDAQAB'

        expect(computeChromeExtensionId(key)).toBe('emaponnolfbhnoaabgiebjmbdlmoifke')
    })
})
