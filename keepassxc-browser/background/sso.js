'use strict';

/**
 * "Sign in with <provider>" (background side). The content side is content/sso.js.
 *
 * A site the user signs in to through a provider has an entry in the database with the site's URL,
 * the provider account as username, no password, the attribute "KPH: sso" = <provider id> and the
 * note "Signs in with <Provider>".
 *
 * Two things are tracked here, both in session storage so they survive the background being suspended:
 *   intent       The user chose "Sign in with <provider>" on a site. Until it ends, the provider's own
 *                pages opened from that tab pick the account, fill it and submit.
 *   pendingSave  The user clicked a site's provider button by hand. When they are back on the site,
 *                it offers to remember the provider.
 */
const kpxcSSO = {};

const SSO_FIELD = 'KPH: sso';
const SSO_INTENT_TIMEOUT = 3 * 60 * 1000;
const SSO_SAVE_TIMEOUT = 10 * 60 * 1000;
const SSO_IGNORED_SITES = 'ssoIgnoredSites';

kpxcSSO.getState = async function(key) {
    const item = await browser.storage.session.get(key);
    return item[key];
};

kpxcSSO.setState = async function(key, value) {
    if (value === undefined) {
        await browser.storage.session.remove(key);
    } else {
        await browser.storage.session.set({ [key]: value });
    }
};

const ssoOrigin = function(url) {
    try {
        return new URL(url).origin;
    } catch (_e) {
        return undefined;
    }
};

// The tab's URL. The tab a message arrives with does not always carry one (Firefox), so ask the browser then.
const ssoTabUrl = async function(tab) {
    if (tab?.url) {
        return tab.url;
    }

    const current = await browser.tabs.get(tab.id).catch(() => undefined);
    return current?.url;
};

// A provider page belongs to a flow when it is the tab that started it, or a tab opened from it or after it
const ssoTabBelongsTo = function(tab, flow) {
    return tab?.id === flow.tabId || tab?.openerTabId === flow.tabId || flow.openedTabs?.includes(tab?.id);
};

kpxcSSO.getIntent = async function() {
    const intent = await kpxcSSO.getState('ssoIntent');
    if (intent && Date.now() - intent.started > SSO_INTENT_TIMEOUT) {
        await kpxcSSO.setState('ssoIntent', undefined);
        return undefined;
    }

    return intent;
};

kpxcSSO.getPendingSave = async function() {
    const pending = await kpxcSSO.getState('ssoPendingSave');
    if (pending && Date.now() - pending.started > SSO_SAVE_TIMEOUT) {
        await kpxcSSO.setState('ssoPendingSave', undefined);
        return undefined;
    }

    return pending;
};

// The user chose "Sign in with <provider>" for a saved entry. args: [ provider, login, uuid ]
kpxcSSO.start = async function(tab, args = []) {
    const [ provider, login, uuid ] = args;
    await kpxcSSO.setState('ssoPendingSave', undefined);
    await kpxcSSO.setState('ssoIntent', {
        done: [],
        login: login,
        openedTabs: [],
        provider: provider,
        siteOrigin: ssoOrigin(await ssoTabUrl(tab)),
        started: Date.now(),
        tabId: tab.id,
        uuid: uuid,
    });
};

// A provider page asks whether it should sign in. args: [ provider ]
kpxcSSO.getIntentForTab = async function(tab, args = []) {
    const [ provider ] = args;
    const intent = await kpxcSSO.getIntent();
    if (!intent || intent.provider !== provider || !ssoTabBelongsTo(tab, intent)) {
        return undefined;
    }

    return intent;
};

// Each step on the provider's pages is done once, so a rejected password is not submitted again.
// args: [ step ]. Returns false when the step was already done.
kpxcSSO.markStep = async function(tab, args = []) {
    const [ step ] = args;
    const intent = await kpxcSSO.getIntent();
    if (!intent || intent.done.includes(step)) {
        return false;
    }

    intent.done.push(step);
    await kpxcSSO.setState('ssoIntent', intent);
    return true;
};

// Whether the sign-in has opened the provider's pop-up or tab yet
kpxcSSO.hasOpenedTab = async function() {
    const intent = await kpxcSSO.getIntent();
    return Boolean(intent) && intent.openedTabs.length > 0;
};

kpxcSSO.end = async function() {
    await kpxcSSO.setState('ssoIntent', undefined);
};

// Asks every frame of the tab to click its button for the provider. args: [ provider ]
kpxcSSO.clickInFrames = async function(tab, args = []) {
    return await browser.tabs.sendMessage(tab.id, { action: 'sso_click_button', args: args }).catch(() => false);
};

// A frame found provider buttons; tell the top frame, which shows the prompt. args: [ providers ]
kpxcSSO.frameButtons = async function(tab, args = []) {
    browser.tabs.sendMessage(tab.id, { action: 'sso_frame_buttons', args: args }, { frameId: 0 }).catch(() => {});
};

// The user clicked a site's provider button by hand. args: [ provider ]
kpxcSSO.buttonClicked = async function(tab, args = []) {
    const [ provider ] = args;
    if (!page.settings.ssoOfferSave || await kpxcSSO.getIntent()) {
        return;
    }

    const siteOrigin = ssoOrigin(await ssoTabUrl(tab));
    const ignored = (await browser.storage.local.get({ [SSO_IGNORED_SITES]: [] }))[SSO_IGNORED_SITES];
    if (!siteOrigin || ignored.includes(siteOrigin)) {
        return;
    }

    await kpxcSSO.setState('ssoPendingSave', {
        leftSite: false,
        login: undefined,
        openedTabs: [],
        provider: provider,
        siteOrigin: siteOrigin,
        started: Date.now(),
        tabId: tab.id,
    });
};

// A provider page reports itself, and the account the user chose there if it saw one. args: [ provider, login ]
kpxcSSO.providerPageSeen = async function(tab, args = []) {
    const [ provider, login ] = args;
    const pending = await kpxcSSO.getPendingSave();
    if (!pending || pending.provider !== provider || !ssoTabBelongsTo(tab, pending)) {
        return;
    }

    pending.leftSite = true;
    pending.login = login || pending.login;
    await kpxcSSO.setState('ssoPendingSave', pending);
};

// The site's page loaded. Ends a sign-in that has been through the provider, and returns the save
// offer if there is one: only once the user has been to the provider and back.
kpxcSSO.siteLoaded = async function(tab) {
    const intent = await kpxcSSO.getIntent();
    if (intent?.tabId === tab.id && intent.siteOrigin === ssoOrigin(await ssoTabUrl(tab)) && intent.done.length > 0) {
        await kpxcSSO.end();
    }

    const pending = await kpxcSSO.getPendingSave();
    if (!pending || pending.tabId !== tab.id || pending.siteOrigin !== ssoOrigin(await ssoTabUrl(tab)) || !pending.leftSite) {
        return undefined;
    }

    return pending;
};

// args: [ never ]. With never, the site is not offered again.
kpxcSSO.dismissSaveOffer = async function(tab, args = []) {
    const [ never ] = args;
    const pending = await kpxcSSO.getPendingSave();
    if (never && pending) {
        const ignored = (await browser.storage.local.get({ [SSO_IGNORED_SITES]: [] }))[SSO_IGNORED_SITES];
        ignored.push(pending.siteOrigin);
        await browser.storage.local.set({ [SSO_IGNORED_SITES]: ignored });
    }

    await kpxcSSO.setState('ssoPendingSave', undefined);
};

// Logins for a URL without the tab's cache, e.g. the provider's accounts while on the site. args: [ url ]
kpxcSSO.getLogins = async function(tab, args = []) {
    const [ url ] = args;
    const logins = await keepass.retrieveCredentials(tab, [ url, url ]);
    return Array.isArray(logins) ? logins : [];
};

// The site's logins, cached on the tab like the ones the login form retrieves
kpxcSSO.getSiteLogins = async function(tab) {
    const currentTab = tabs.getTabFromId(tab.id);
    if (currentTab?.credentials?.length > 0) {
        return currentTab.credentials;
    }

    const logins = await kpxcSSO.getLogins(tab, [ await ssoTabUrl(tab) ]);
    tabs.updateTabValues(tab.id, { credentials: logins });
    return logins;
};

/**
 * Saves the site's entry: the provider account as username, no password, the flag and the note.
 * args: [ provider, providerName, login ]
 * Returns 'saved', 'no-flag' when KeePassXC stored the entry without the flag (it needs the
 * set-login extension from our KeePassXC build), or 'error'.
 */
kpxcSSO.save = async function(tab, args = []) {
    const [ provider, providerName, login ] = args;
    const pending = await kpxcSSO.getPendingSave();
    const siteOrigin = pending?.siteOrigin ?? ssoOrigin(await ssoTabUrl(tab));
    await kpxcSSO.setState('ssoPendingSave', undefined);

    try {
        if (!siteOrigin || containsPlaceholder(login) || !await keepass.testAssociation(tab)) {
            return 'error';
        }

        const [ dbid ] = keepass.getCryptoKey();
        const url = siteOrigin + '/';
        const response = await keepassClient.sendMessage(kpActions.SET_LOGIN, tab, {
            action: kpActions.SET_LOGIN,
            id: dbid,
            login: login,
            notes: `Signs in with ${providerName}`,
            password: '',
            stringFields: [ { [SSO_FIELD]: provider } ],
            submitUrl: url,
            url: url,
        }, keepassClient.getNonce());
        if (!response) {
            return 'error';
        }

        tabs.updateTabValues(tab.id, { credentials: [] });
        const saved = await kpxcSSO.getSiteLogins(tab);
        const flagged = saved.some(c => c.login === login && c.stringFields?.some(f => f[SSO_FIELD] === provider));
        return flagged ? 'saved' : 'no-flag';
    } catch (err) {
        logError(`kpxcSSO.save failed: ${err}`);
        return 'error';
    }
};

// Tabs opened while a flow is running are the provider's popup or new tab
kpxcSSO.onTabCreated = async function(tab) {
    for (const [ key, getter ] of [ [ 'ssoIntent', kpxcSSO.getIntent ], [ 'ssoPendingSave', kpxcSSO.getPendingSave ] ]) {
        const flow = await getter();
        if (flow && tab.id !== flow.tabId && !flow.openedTabs.includes(tab.id)) {
            flow.openedTabs.push(tab.id);
            await kpxcSSO.setState(key, flow);
        }
    }
};

// When the provider's popup closes the site's page has not reloaded, so tell it to offer saving
kpxcSSO.onTabRemoved = async function(tabId) {
    const pending = await kpxcSSO.getPendingSave();
    if (pending?.leftSite && pending.openedTabs.includes(tabId)) {
        browser.tabs.sendMessage(pending.tabId, { action: 'sso_offer_save' }, { frameId: 0 }).catch(() => {});
    }
};
