const { generators } = require('openid-client');
const { JWKS, JWS, JWK } = require('jose');
const { signing: deriveKey } = require('./hkdf');

const header = { alg: 'HS256', b64: false, crit: ['b64'] };
const getPayload = (cookie, value) => Buffer.from(`${cookie}=${value}`);
const flattenedJWSFromCookie = (cookie, value, signature) => ({
  protected: Buffer.from(JSON.stringify(header))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_'),
  payload: getPayload(cookie, value),
  signature,
});
const generateSignature = (cookie, value, key) => {
  const payload = getPayload(cookie, value);
  return JWS.sign.flattened(payload, key, header).signature;
};
const verifySignature = (cookie, value, signature, keystore) => {
  try {
    return !!JWS.verify(
      flattenedJWSFromCookie(cookie, value, signature),
      keystore,
      { algorithm: 'HS256', crit: ['b64'] }
    );
  } catch (err) {
    return false;
  }
};
const getCookieValue = (cookie, value, keystore) => {
  if (!value) {
    return undefined;
  }
  let signature;
  [value, signature] = value.split('.');
  if (verifySignature(cookie, value, signature, keystore)) {
    return value;
  }

  return undefined;
};

const generateCookieValue = (cookie, value, key) => {
  const signature = generateSignature(cookie, value, key);
  return `${value}.${signature}`;
};

const COOKIES = require('./cookies');

class TransientCookieHandler {
  constructor({ secret, session, legacySameSiteCookie }) {
    let current;

    const secrets = Array.isArray(secret) ? secret : [secret];
    let keystore = new JWKS.KeyStore();
    secrets.forEach((secretString, i) => {
      const key = JWK.asKey(deriveKey(secretString));
      if (i === 0) {
        current = key;
      }
      keystore.add(key);
    });

    if (keystore.size === 1) {
      keystore = current;
    }
    this.currentKey = current;
    this.keyStore = keystore;
    this.sessionCookieConfig = (session && session.cookie) || {};
    this.legacySameSiteCookie = legacySameSiteCookie;
  }

  /**
   * Set a cookie with a value or a generated nonce.
   *
   * @param {String} key Cookie name to use.
   * @param {Object} req Express Request object.
   * @param {Object} res Express Response object.
   * @param {Object} opts Options object.
   * @param {String} opts.sameSite SameSite attribute of "None," "Lax," or "Strict". Default is "None."
   * @param {String} opts.value Cookie value. Omit this key to store a generated value.
   * @param {Boolean} opts.legacySameSiteCookie Should a fallback cookie be set? Default is true.
   *
   * @return {String} Cookie value that was set.
   */
  store(
    key,
    req,
    res,
    { sameSite = 'None', value = this.generateNonce() } = {}
  ) {
    const isSameSiteNone = sameSite === 'None';
    const { domain, path, secure } = this.sessionCookieConfig;
    const basicAttr = {
      httpOnly: true,
      secure,
      domain,
      path,
    };

    {
      const cookieValue = generateCookieValue(key, value, this.currentKey);
      // Set the cookie with the SameSite attribute and, if needed, the Secure flag.
      res.cookie(key, cookieValue, {
        ...basicAttr,
        sameSite,
        secure: isSameSiteNone ? true : basicAttr.secure,
      });
    }

    if (isSameSiteNone && this.legacySameSiteCookie) {
      const cookieValue = generateCookieValue(
        `_${key}`,
        value,
        this.currentKey
      );
      // Set the fallback cookie with no SameSite or Secure attributes.
      res.cookie(`_${key}`, cookieValue, basicAttr);
    }

    return value;
  }

  /**
   * Get a cookie value then delete it.
   *
   * @param {String} key Cookie name to use.
   * @param {Object} req Express Request object.
   * @param {Object} res Express Response object.
   *
   * @return {String|undefined} Cookie value or undefined if cookie was not found.
   */
  getOnce(key, req, res) {
    if (!req[COOKIES]) {
      return undefined;
    }

    const { secure, sameSite } = this.sessionCookieConfig;

    let value = getCookieValue(key, req[COOKIES][key], this.keyStore);
    this.deleteCookie(key, res, { secure, sameSite });

    if (this.legacySameSiteCookie) {
      const fallbackKey = `_${key}`;
      if (!value) {
        value = getCookieValue(
          fallbackKey,
          req[COOKIES][fallbackKey],
          this.keyStore
        );
      }
      this.deleteCookie(fallbackKey, res);
    }

    return value;
  }

  /**
   * Generates a nonce value.
   *
   * @return {String}
   */
  generateNonce() {
    return generators.nonce();
  }

  /**
   * Generates a code_verifier value.
   *
   * @return {String}
   */
  generateCodeVerifier() {
    return generators.codeVerifier();
  }

  /**
   * Calculates a code_challenge value for a given codeVerifier
   *
   * @param {String} codeVerifier Code Verifier to calculate the code_challenge value from.
   *
   * @return {String}
   */
  calculateCodeChallenge(codeVerifier) {
    return generators.codeChallenge(codeVerifier);
  }

  /**
   * Clears the cookie from the browser by setting an empty value and an expiration date in the past
   *
   * @param {String} name Cookie name
   * @param {Object} res Express Response object
   * @param {Object?} opts Optional SameSite and Secure cookie options for modern browsers
   */
  deleteCookie(name, res, opts = {}) {
    const { domain, path } = this.sessionCookieConfig;
    const { sameSite, secure } = opts;
    res.clearCookie(name, {
      domain,
      path,
      sameSite,
      secure,
    });
  }
}

module.exports = TransientCookieHandler;
