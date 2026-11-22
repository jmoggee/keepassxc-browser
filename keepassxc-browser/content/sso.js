'use strict';

/**
 * "Sign in with <provider>" (content side). The background side and the entry format are in background/sso.js.
 *
 * On a site:
 *   - finds the site's provider buttons ("Sign in with Google", ...), in every frame
 *   - if the database has an entry for the site flagged with that provider, shows a card offering to sign in.
 *     Choosing it records the intent in the background and clicks the site's button.
 *   - if the user clicks a provider button by hand, the background remembers it, and once the user is back
 *     from the provider a card offers to save it.
 *
 * On the provider's own pages, while an intent is running for this tab: picks the account in the account
 * chooser, fills the account's login from the database, and submits. Each step is done once. Consent
 * screens ("Allow", "Authorize") are left to the user.
 */
const kpxcSSO = {};
kpxcSSO.buttons = new Map(); // provider id -> element in this frame
kpxcSSO.frameProviders = new Set(); // provider ids found in child frames (top frame only)
kpxcSSO.card = undefined;
kpxcSSO.dismissed = false;
kpxcSSO.intent = undefined;
kpxcSSO.rescans = 0;

const SSO_FIELD = 'KPH: sso';
const SSO_MAX_RESCANS = 40;
const SSO_MAX_BUTTON_TEXT = 48;

// Words that make a button a sign-in button rather than e.g. a share button
const SSO_ACTION_WORDS =
    /sign|log|continue|connect|auth|join|with|using|via|anmeld|weiter|connexion|connecter|continuer|inicia|acced|entra|accedi|meld|doorgaan/i;

/**
 * hosts      where the provider's own sign-in pages live
 * loginUrl   the URL the provider account's entry is looked up with
 * names      how the provider is named on buttons
 * links      what a link to the provider's sign-in looks like
 */
const SSO_PROVIDERS = [
    {
        id: 'google',
        name: 'Google',
        hosts: [ 'accounts.google.com' ],
        loginUrl: 'https://accounts.google.com/',
        names: /\bgoogle\b/i,
        links: /accounts\.google\.com\/(o\/oauth2|signin|gsi|v3\/signin)/i,
    },
    {
        id: 'github',
        name: 'GitHub',
        hosts: [ 'github.com' ],
        loginUrl: 'https://github.com/login',
        names: /\bgithub\b/i,
        links: /github\.com\/login\/oauth/i,
    },
    {
        id: 'microsoft',
        name: 'Microsoft',
        hosts: [ 'login.microsoftonline.com', 'login.live.com' ],
        loginUrl: 'https://login.microsoftonline.com/',
        names: /\bmicrosoft\b|\boffice ?365\b|\bentra\b/i,
        links: /login\.(microsoftonline|live)\.com\/.*(oauth2|authorize)/i,
    },
    {
        id: 'apple',
        name: 'Apple',
        hosts: [ 'appleid.apple.com', 'idmsa.apple.com' ],
        loginUrl: 'https://appleid.apple.com/',
        names: /\bapple\b/i,
        links: /appleid\.apple\.com\/auth\/authorize/i,
    },
    {
        id: 'facebook',
        name: 'Facebook',
        hosts: [ 'www.facebook.com', 'facebook.com', 'm.facebook.com' ],
        loginUrl: 'https://www.facebook.com/',
        names: /\bfacebook\b/i,
        links: /facebook\.com\/(v[\d.]+\/)?dialog\/oauth/i,
    },
    {
        id: 'gitlab',
        name: 'GitLab',
        hosts: [ 'gitlab.com' ],
        loginUrl: 'https://gitlab.com/users/sign_in',
        names: /\bgitlab\b/i,
        links: /gitlab\.com\/oauth\/authorize/i,
    },
    {
        id: 'discord',
        name: 'Discord',
        hosts: [ 'discord.com' ],
        loginUrl: 'https://discord.com/login',
        names: /\bdiscord\b/i,
        links: /discord\.com\/(api\/)?oauth2\/authorize/i,
    },
    {
        id: 'x',
        name: 'X',
        hosts: [ 'x.com', 'twitter.com', 'api.twitter.com', 'api.x.com' ],
        loginUrl: 'https://x.com/',
        names: /\btwitter\b|(^|with |using |via )x$/i,
        links: /(twitter|x)\.com\/(i\/)?oauth2?\/(authorize|authenticate)/i,
    },
    {
        id: 'amazon',
        name: 'Amazon',
        hosts: [ 'www.amazon.com', 'na.account.amazon.com' ],
        loginUrl: 'https://www.amazon.com/',
        names: /\bamazon\b/i,
        links: /amazon\.com\/ap\/oa/i,
    },
    {
        id: 'slack',
        name: 'Slack',
        hosts: [ 'slack.com' ],
        loginUrl: 'https://slack.com/signin',
        names: /\bslack\b/i,
        links: /slack\.com\/(oauth|openid\/connect)\/(v2\/)?authorize/i,
    },
    {
        id: 'linkedin',
        name: 'LinkedIn',
        hosts: [ 'www.linkedin.com' ],
        loginUrl: 'https://www.linkedin.com/login',
        names: /\blinkedin\b/i,
        links: /linkedin\.com\/oauth\/v2\/authorization/i,
    },
];

kpxcSSO.getProvider = function(id) {
    return SSO_PROVIDERS.find(p => p.id === id);
};

// The provider whose sign-in pages this document belongs to
kpxcSSO.getPageProvider = function() {
    return SSO_PROVIDERS.find(p => p.hosts.includes(document.location.hostname));
};

// The provider a credential is flagged with, if any
kpxcSSO.getCredentialProvider = function(credential) {
    const field = credential?.stringFields?.find(f => Object.hasOwn(f, SSO_FIELD));
    return field ? kpxcSSO.getProvider(String(field[SSO_FIELD]).trim().toLowerCase()) : undefined;
};

const ssoIsVisible = function(elem) {
    const rect = elem.getBoundingClientRect();
    return rect.width > 8 && rect.height > 8 && getComputedStyle(elem).visibility !== 'hidden';
};

// What a button says: its text, or failing that its label, title, value or image description
const ssoButtonText = function(elem) {
    const candidates = [
        elem.textContent,
        elem.getAttribute('aria-label'),
        elem.getAttribute('title'),
        elem.value,
        elem.querySelector?.('img[alt]')?.getAttribute('alt'),
        elem.querySelector?.('svg title')?.textContent,
    ];

    for (const candidate of candidates) {
        const text = typeof candidate === 'string' ? candidate.replace(/\s+/g, ' ').trim() : '';
        if (text) {
            return text;
        }
    }

    return '';
};

const ssoMatchesProvider = function(elem, provider) {
    const link = elem.getAttribute('href') || elem.getAttribute('formaction') || elem.getAttribute('src') || '';
    if (provider.links.test(link)) {
        return true;
    }

    const text = ssoButtonText(elem);
    if (!text || text.length > SSO_MAX_BUTTON_TEXT || !provider.names.test(text)) {
        return false;
    }

    // Either the button is just the provider's name, or it says to sign in with it
    return text.toLowerCase() === provider.name.toLowerCase() || SSO_ACTION_WORDS.test(text.replace(provider.names, ''));
};

// Finds this frame's provider buttons. Returns true if the set of providers changed.
kpxcSSO.scan = function() {
    const found = new Map();
    const pageProvider = kpxcSSO.getPageProvider();

    // Google's rendered button is a frame of its own
    if (document.location.hostname === 'accounts.google.com' && document.location.pathname.startsWith('/gsi/button')) {
        found.set('google', document.querySelector('[role=button]') || document.body);
    } else {
        const candidates = document.querySelectorAll(
            'a, button, [role=button], input[type=submit], input[type=button], iframe[src*="accounts.google.com/gsi/button"]'
        );
        for (const elem of candidates) {
            for (const provider of SSO_PROVIDERS) {
                if (provider !== pageProvider
                    && !found.has(provider.id)
                    && ssoMatchesProvider(elem, provider)
                    && ssoIsVisible(elem)) {
                    found.set(provider.id, elem);
                }
            }
        }
    }

    const changed = found.size !== kpxcSSO.buttons.size || [ ...found.keys() ].some(id => !kpxcSSO.buttons.has(id));
    kpxcSSO.buttons = found;
    return changed;
};

// Providers that can be signed in with on this page, counting child frames
kpxcSSO.availableProviders = function() {
    return new Set([ ...kpxcSSO.buttons.keys(), ...kpxcSSO.frameProviders ]);
};

kpxcSSO.onButtonsChanged = async function() {
    if (window.self !== window.top) {
        if (kpxcSSO.buttons.size > 0) {
            sendMessage('sso_frame_buttons', [ [ ...kpxcSSO.buttons.keys() ] ]);
        }
        return;
    }

    await kpxcSSO.offerSignIn();
};

// Shows the sign-in card when the database has a flagged entry for a provider this page offers
kpxcSSO.offerSignIn = async function() {
    const available = kpxcSSO.availableProviders();
    if (!kpxc.settings.ssoSignIn
        || kpxcSSO.card
        || kpxcSSO.dismissed
        || kpxcSSO.intent
        || available.size === 0
        || kpxc.databaseState !== DatabaseState.UNLOCKED) {
        return;
    }

    const logins = kpxc.credentials.length > 0 ? kpxc.credentials : await sendMessage('sso_get_site_logins');
    const matches = (logins || []).filter(c => available.has(kpxcSSO.getCredentialProvider(c)?.id));
    if (matches.length > 0 && !kpxcSSO.card) {
        kpxcSSO.showSignInCard(matches);
    }
};

// The user chose a flagged entry: record the intent, then press the site's own button
kpxcSSO.signIn = async function(credential) {
    const provider = kpxcSSO.getCredentialProvider(credential);
    if (!provider) {
        return;
    }

    kpxcSSO.closeCard();
    if (!kpxcSSO.availableProviders().has(provider.id)) {
        kpxcSSO.scan();
    }

    if (!kpxcSSO.availableProviders().has(provider.id)) {
        kpxcUI.createNotification('warning', tr('ssoButtonNotFound', provider.name));
        return;
    }

    await sendMessage('sso_start', [ provider.id, credential.login, credential.uuid ]);

    const button = kpxcSSO.buttons.get(provider.id);
    if (button && !matchesWithNodeName(button, 'IFRAME')) {
        button.click();
    } else {
        // The button is in a frame; a click made from here may be blocked there, so point at it too
        sendMessage('sso_click_in_frames', [ provider.id ]);
        if (button) {
            kpxcSSO.highlight(button);
        }
    }
};

kpxcSSO.highlight = function(elem) {
    const previous = elem.style.outline;
    elem.style.outline = '3px solid #7aa2f7';
    elem.scrollIntoView({ block: 'nearest' });
    setTimeout(() => elem.style.outline = previous, 4000);
};

// Asked by the top frame through the background
kpxcSSO.clickButton = function(providerId) {
    const button = kpxcSSO.buttons.get(providerId);
    if (button && !matchesWithNodeName(button, 'IFRAME')) {
        button.click();
    }
};

//--------------------------------------------------------------------------
// The provider's own pages
//--------------------------------------------------------------------------

const ssoSameAccount = (a, b) => Boolean(a) && Boolean(b) && a.trim().toLowerCase() === b.trim().toLowerCase();

// The row for the account in the provider's account chooser
kpxcSSO.findAccountTile = function(login) {
    const tiles = document.querySelectorAll('[data-identifier], [data-email], [data-test-id]');
    for (const tile of tiles) {
        const account = tile.getAttribute('data-identifier')
            || tile.getAttribute('data-email')
            || tile.getAttribute('data-test-id');
        if (ssoSameAccount(account, login) && ssoIsVisible(tile)) {
            return tile;
        }
    }

    return undefined;
};

// One step of signing in at the provider. Called again whenever the page changes.
kpxcSSO.continueAtProvider = async function() {
    const intent = kpxcSSO.intent;
    if (!intent) {
        return;
    }

    const tile = kpxcSSO.findAccountTile(intent.login);
    if (tile) {
        if (await sendMessage('sso_mark_step', [ 'choose-account' ])) {
            tile.click();
        }
        return;
    }

    // The page is already asking for another account's password: leave it alone
    const shownAccount = kpxcSites.detectUsernameFromPage();
    if (shownAccount && !ssoSameAccount(shownAccount, intent.login)) {
        return;
    }

    const credential = kpxc.credentials.find(c => ssoSameAccount(c.login, intent.login) && c.password);
    const combination = kpxc.combinations.find(c => c.username || c.password);
    if (!credential || !combination) {
        return;
    }

    const totpCombination = kpxc.combinations.find(c => c.totp);
    if (totpCombination && !combination.password && kpxc.entryHasTotp(credential)) {
        if (await sendMessage('sso_mark_step', [ 'totp' ])) {
            await kpxcFill.fillTOTPFromUuid(totpCombination.totp, credential.uuid);
        }
        return;
    }

    const step = combination.password ? 'password' : 'username';
    if (!await sendMessage('sso_mark_step', [ step ])) {
        return;
    }

    await kpxcFill.fillInCredentials(combination, credential.login, credential.uuid);

    // With auto-submit on, filling has submitted already
    if (!kpxc.settings.autoSubmit) {
        const submitButton = combination.submitButton ?? kpxcForm.getFormSubmitButton(combination.form);
        if (submitButton) {
            submitButton.click();
        } else if (combination.form) {
            combination.form.requestSubmit();
        }
    }
};

// Tells the background which account the user is signing in with, for the save offer
kpxcSSO.reportProviderPage = function(provider) {
    const report = (login) => sendMessage('sso_provider_page_seen', [ provider.id, login ]);
    report(kpxcSites.detectUsernameFromPage());

    const accountQuery =
        'input[type=email], input[name=identifier], input[name=login], input[name=loginfmt], input[autocomplete~=username]';
    const reportTyped = function(e) {
        if (!e.isTrusted) {
            return;
        }

        const tile = e.target?.closest?.('[data-identifier], [data-email]');
        const login = tile?.getAttribute('data-identifier')
            || tile?.getAttribute('data-email')
            || document.querySelector(accountQuery)?.value;
        if (login) {
            report(login);
        }
    };

    document.addEventListener('click', reportTyped, true);
    document.addEventListener('keydown', e => e.key === 'Enter' && reportTyped(e), true);
};

//--------------------------------------------------------------------------
// Cards
//--------------------------------------------------------------------------

kpxcSSO.closeCard = function() {
    kpxcSSO.card?.remove();
    kpxcSSO.card = undefined;
};

// An empty card in its own shadow root, top right of the page
kpxcSSO.createCard = function(title) {
    kpxcSSO.closeCard();

    const wrapper = document.createElement('div');
    wrapper.style.all = 'unset';
    wrapper.style.display = 'none';
    const styleSheet = createStylesheet('css/sso.css');
    styleSheet.addEventListener('load', () => wrapper.style.display = 'block');

    const shadowRoot = wrapper.attachShadow({ mode: 'closed' });
    const card = kpxcUI.createElement('div', 'kpxc-sso-card');
    initColorTheme(card);

    const header = kpxcUI.createElement('div', 'kpxc-sso-header');
    const icon = kpxcUI.createElement('img', 'kpxc-sso-icon', { src: browser.runtime.getURL('icons/keepassxc.svg'), alt: '' });
    const heading = kpxcUI.createElement('span', 'kpxc-sso-title', {}, title);
    const close = kpxcUI.createElement('button', 'kpxc-sso-close', { title: tr('popupButtonClose'), type: 'button' }, '×');
    header.append(icon, heading, close);
    card.append(header);

    shadowRoot.append(createStylesheet('css/colors.css'), styleSheet, card);
    document.body.append(wrapper);
    kpxcSSO.card = wrapper;
    return { card, close };
};

kpxcSSO.showSignInCard = function(credentials) {
    const { card, close } = kpxcSSO.createCard(tr('ssoSignInTitle'));
    close.addEventListener('click', () => {
        kpxcSSO.dismissed = true;
        kpxcSSO.closeCard();
    });

    for (const credential of credentials) {
        const provider = kpxcSSO.getCredentialProvider(credential);
        const row = kpxcUI.createElement('div', 'kpxc-sso-row');
        const text = kpxcUI.createElement('div', 'kpxc-sso-text');
        text.append(
            kpxcUI.createElement('div', 'kpxc-sso-provider', {}, tr('ssoSignInWith', provider.name)),
            kpxcUI.createElement('div', 'kpxc-sso-account', {}, credential.login || tr('credentialsNoUsername')),
        );

        const button = kpxcUI.createElement('button', 'kpxc-sso-button', { type: 'button' }, tr('ssoSignIn'));
        button.addEventListener('click', (e) => {
            if (e.isTrusted) {
                kpxcSSO.signIn(credential);
            }
        });

        row.append(text, button);
        card.append(row);
    }
};

// offer: the pending save from the background ({ provider, login, siteOrigin })
kpxcSSO.showSaveCard = async function(offer) {
    const provider = kpxcSSO.getProvider(offer.provider);
    if (!provider || !kpxc.settings.ssoOfferSave || kpxc.databaseState !== DatabaseState.UNLOCKED) {
        return;
    }

    // Already saved for this site
    const siteLogins = await sendMessage('sso_get_site_logins') || [];
    if (siteLogins.some(c => kpxcSSO.getCredentialProvider(c)?.id === provider.id)) {
        sendMessage('sso_dismiss_save_offer', [ false ]);
        return;
    }

    const accounts = [ ...new Set((await sendMessage('sso_get_logins', [ provider.loginUrl ]) || []).map(c => c.login)) ]
        .filter(Boolean);

    const { card, close } = kpxcSSO.createCard(tr('ssoSaveTitle'));
    const site = new URL(offer.siteOrigin).hostname;
    card.append(kpxcUI.createElement('div', 'kpxc-sso-message', {}, tr('ssoSaveMessage', [ site, provider.name ])));

    // Pick from the provider's accounts in the database, or type one
    const account = kpxcUI.createElement('input', 'kpxc-sso-input', {
        list: 'kpxc-sso-accounts',
        placeholder: tr('ssoSaveAccount', provider.name),
        type: 'text',
    });
    account.value = accounts.find(a => ssoSameAccount(a, offer.login)) || offer.login || accounts[0] || '';
    const list = kpxcUI.createElement('datalist', '', { id: 'kpxc-sso-accounts' });
    for (const a of accounts) {
        list.append(kpxcUI.createElement('option', '', { value: a }));
    }

    const buttons = kpxcUI.createElement('div', 'kpxc-sso-actions');
    const save = kpxcUI.createElement('button', 'kpxc-sso-button', { type: 'button' }, tr('optionsButtonSave'));
    const never = kpxcUI.createElement('button', 'kpxc-sso-button kpxc-sso-button--plain', { type: 'button' }, tr('ssoSaveNever'));
    buttons.append(never, save);
    card.append(account, list, buttons);

    const dismiss = function(forever) {
        sendMessage('sso_dismiss_save_offer', [ forever ]);
        kpxcSSO.closeCard();
    };

    close.addEventListener('click', () => dismiss(false));
    never.addEventListener('click', () => dismiss(true));
    save.addEventListener('click', async (e) => {
        if (!e.isTrusted) {
            return;
        }

        const login = account.value.trim();
        kpxcSSO.closeCard();
        const result = await sendMessage('sso_save', [ provider.id, provider.name, login ]);
        if (result === 'saved') {
            kpxcUI.createNotification('success', tr('ssoSaved', [ site, provider.name ]));
            kpxc.credentials = [];
        } else if (result === 'no-flag') {
            kpxcUI.createNotification('warning', tr('ssoSavedWithoutFlag'));
        } else {
            kpxcUI.createNotification('error', tr('rememberErrorCannotSaveCredentials'));
        }
    });
};

//--------------------------------------------------------------------------
// Start-up
//--------------------------------------------------------------------------

// Re-checks the page after it changes; sign-in pages often render late
kpxcSSO.observe = function() {
    let timer;
    const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (++kpxcSSO.rescans > SSO_MAX_RESCANS) {
                observer.disconnect();
                return;
            }

            if (kpxcSSO.intent) {
                await kpxcSSO.continueAtProvider();
            } else if (kpxcSSO.scan()) {
                await kpxcSSO.onButtonsChanged();
            }
        }, 400);
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }
};

// Called when the login form's credentials arrive
kpxcSSO.onCredentials = async function() {
    if (kpxcSSO.intent) {
        await kpxcSSO.continueAtProvider();
    } else if (window.self === window.top) {
        await kpxcSSO.offerSignIn();
    }
};

kpxcSSO.init = async function() {
    if (!kpxc.settings.ssoSignIn && !kpxc.settings.ssoOfferSave) {
        return;
    }

    const isTop = window.self === window.top;
    const pageProvider = kpxcSSO.getPageProvider();

    if (isTop && pageProvider) {
        kpxcSSO.intent = await sendMessage('sso_get_intent', [ pageProvider.id ]);
        if (kpxcSSO.intent) {
            kpxcSSO.observe();
            await kpxcSSO.continueAtProvider();
            return;
        }

        kpxcSSO.reportProviderPage(pageProvider);
    }

    if (isTop) {
        // Back on the site after signing in: ends a finished sign-in, and may offer to save
        const offer = await sendMessage('sso_site_loaded');
        if (offer) {
            kpxcSSO.showSaveCard(offer);
        }
    }

    // A provider button clicked by hand is remembered for the save offer
    document.addEventListener('click', (e) => {
        if (!e.isTrusted) {
            return;
        }

        for (const [ id, button ] of kpxcSSO.buttons) {
            if (button.contains(e.target)) {
                sendMessage('sso_button_clicked', [ id ]);
                return;
            }
        }
    }, true);

    if (kpxcSSO.scan()) {
        await kpxcSSO.onButtonsChanged();
    }
    kpxcSSO.observe();
};
