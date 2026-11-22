'use strict';

const $ = function(elem) {
    return document.querySelector(elem);
};

function updateAvailableResponse(available) {
    if (available) {
        $('#update-available').show();
    }
}

async function initSettings() {
    $('#settings #options-button').addEventListener('click', () => {
        browser.runtime.openOptionsPage().then(close());
    });

    const customLoginFieldsButton = document.body.querySelector('#settings #choose-custom-login-fields-button');
    customLoginFieldsButton.id = getIconClass('choose-custom-login-fields-button');

    customLoginFieldsButton.addEventListener('click', async () => {
        const tab = await getCurrentTab();
        browser.tabs.sendMessage(tab?.id, {
            action: 'choose_credential_fields'
        });
        close();
    });
}

async function initColorTheme() {
    const theme = await browser.runtime.sendMessage({
        action: 'get_color_theme'
    });
    applyColorTheme(document.documentElement, theme);
}

async function getLoginData(useBasicAuth = false) {
    const tab = await getCurrentTab();
    if (!tab) {
        return [];
    }

    const logins = await browser.runtime.sendMessage({
        action: 'get_login_list',
        args: useBasicAuth
    });

    return logins;
}

(async () => {
    if (document.readyState === 'complete' || (document.readyState !== 'loading' && !document.documentElement.doScroll)) {
        await initSettings();
    } else {
        document.addEventListener('DOMContentLoaded', initSettings);
    }

    updateAvailableResponse(await browser.runtime.sendMessage({
        action: 'update_available_keepassxc'
    }));
})();
