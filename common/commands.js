/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log,
  configs,
  handleMissingReceiverError,
  notify,
  collectTabsFromTree,
} from './common.js';
import * as Constants from './constants.js';
import * as Permissions from './permissions.js';
import * as Replacer from './replacer.js';
import * as FunctionalPlaceHolder from './functional-placeholder.js';

export async function getMultiselectedTabs(tab) {
  if (!tab)
    return [];
  if (tab.highlighted)
    return browser.tabs.query({
      windowId:    tab.windowId,
      highlighted: true
    });
  else
    return [tab];
}

export async function getContextState({ baseTab, selectedTabs, callbackOption, withContainer } = {}) {
  if (callbackOption === undefined)
    callbackOption = configs.fallbackForSingleTab;

  if (!selectedTabs)
    selectedTabs = await getMultiselectedTabs(baseTab);

  const isAll = callbackOption == Constants.kCOPY_ALL;
  const shouldCollectTree = callbackOption == Constants.kCOPY_TREE || callbackOption == Constants.kCOPY_TREE_DESCENDANTS;
  const treeItem = selectedTabs.length == 1 && shouldCollectTree && await browser.runtime.sendMessage(Constants.kTST_ID, {
    type: Constants.kTSTAPI_GET_TREE,
    tab:  baseTab.id
  }).catch(_error => null);
  const isTree = (
    treeItem &&
    treeItem.children.length > 0
  );
  const onlyDescendants = (
    isTree &&
    callbackOption == Constants.kCOPY_TREE_DESCENDANTS
  );
  log('isTree: ', { isTree, onlyDescendants });

  const hasMultipleTabs = (
    (isTree &&
     [...(onlyDescendants ? [] : [treeItem]), ...treeItem.children]) ||
    selectedTabs
  ).length > 1;

  const tabs = isAll ?
    (await browser.tabs.query({
      windowId: baseTab.windowId,
      hidden:   false,
    }).catch(_error => [])) :
    (isTree && await collectTabsFromTree(treeItem, { onlyDescendants })) || selectedTabs;
  if (withContainer) {
    await Promise.all(tabs.map(async tab => {
      try {
        const container = await browser.contextualIdentities.get(tab.cookieStoreId);
        tab.container = container && container.name;
      }
      catch(_error) {
        tab.container = null;
      }
    }));
  }
  return { isAll, isTree, onlyDescendants, hasMultipleTabs, tabs };
}

const kFORMAT_PARAMETER_MATCHER  = /\([^\)]+\)|\[[^\]]+\]|\{[^\}]+\}|<[^>]+>/g;
const kFORMAT_MATCHER_TST_INDENT = new RegExp(`%TST_INDENT(?:${kFORMAT_PARAMETER_MATCHER.source})*%`, 'gi');

export async function copyToClipboard(tabs, format) {
  let indentLevels = [];
  if (kFORMAT_MATCHER_TST_INDENT.test(format)) {
    try {
      const tabsWithChildren = await browser.runtime.sendMessage(Constants.kTST_ID, {
        type: 'get-tree',
        tabs: tabs.map(tab => tab.id)
      }).catch(handleMissingReceiverError);
      const ancestorsOf = {};
      const collectAncestors = (tab) => {
        ancestorsOf[tab.id] = ancestorsOf[tab.id] || [];
        for (const child of tab.children) {
          collectAncestors(child);
          ancestorsOf[child.id] = [tab.id].concat(ancestorsOf[tab.id]);
        }
      };
      for (const tab of tabsWithChildren) {
        collectAncestors(tab);
      }
      // ignore indent information for partial selection
      const ids = tabs.map(tab => tab.id);
      indentLevels = tabsWithChildren.map(tab => {
        return ancestorsOf[tab.id].filter(ancestorId => ids.indexOf(ancestorId) > -1).length
      });
    }
    catch(_e) {
    }
  }

  const lineFeed = configs.useCRLF ? '\r\n' : '\n' ;
  const itemsToCopy = await Promise.all(tabs.map((tab, index) => fillPlaceHolders(format, tab, indentLevels[index])));

  const richText = /%RT%/i.test(format) ? itemsToCopy.map(item => item.richText).join('<br />') : null ;
  let plainText = itemsToCopy.map(item => item.plainText).join(lineFeed);
  if (tabs.length > 1)
    plainText += lineFeed;

  log('richText: ', richText);
  log('plainText: ', plainText);

  if (!richText) {
    log('trying to write text to clipboard via Clipboard API');
    try {
      navigator.clipboard.writeText(plainText)
        .then(() => {
          notifyCopied(tabs.length, plainText);
        })
        .catch(error => {
          notifyFailed(error);
        });
      return;
    }
    catch(error) {
      notifyFailed(error);
    }
    return;
  }

  if (typeof navigator.clipboard.write == 'function') {
    log('trying to write data to clipboard via Clipboard API');
    try {
      const dt = new DataTransfer();
      dt.items.add(plainText, 'text/plain');
      dt.items.add(richText, 'text/html');
      navigator.clipboard.write(dt)
        .then(() => {
          notifyCopied(tabs.length, plainText);
        })
        .catch(error => {
          notifyFailed(error);
        });
      return;
    }
    catch(error) {
      notifyFailed(error);
    }
    return;
  }

  const doCopy = function() {
    let done = false;
    return new Promise((resolve, _reject) => {
      // This block won't work if dom.event.clipboardevents.enabled=false.
      // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1396275
      document.addEventListener('copy', event => {
        if (done)
          return;
        event.stopImmediatePropagation();
        event.preventDefault();
        event.clipboardData.setData('text/plain', plainText);
        event.clipboardData.setData('text/html',  richText);
        done = true;
        resolve(true);
      }, {
        once:    true,
        capture: true
      });
      document.execCommand('copy');
      setTimeout(() => {
        if (done)
          return;
        done = true;
        resolve(false);
      }, 250);
    });
  };

  log('trying to write data to clipboard via execCommand with a content page');
  /* Due to Firefox's limitation, we cannot copy text from background script.
     Moreover, when this command is called from context menu on a tab,
     there is no browser_action page.
     Thus we need to use a temporary blank tab or window and execute
     the copy command inside its content area.
     See also:
      https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Interact_with_the_clipboard#Browser-specific_considerations
      https://bugzilla.mozilla.org/show_bug.cgi?id=1272869
      https://bugzilla.mozilla.org/show_bug.cgi?id=1344410
  */
  let temporaryTab;
  let temporaryWindow;
  try {
    temporaryTab = await browser.tabs.create({
      windowId: tabs[0].windowId,
      url:      'about:blank',
      active:   false,
      // hidden:   true, // not supported...
      index:    (tabs.find(tab => tab.active) || tabs[0]).index + 1, // open next to the visible tab to prevent scrolling of the tab bar
    });
  }
  catch(error) {
    try {
      log(`cannot open temporary tab in the window ${tabs[0].windowId}, retrying with a temporary window. `, error);
      temporaryWindow = await browser.windows.create({
        url:    'about:blank',
        width:  100,
        height: 100,
        left:   0,
        top:    0
      });
      const [activeTab] = await browser.tabs.query({
        active: true,
        windowId: temporaryWindow.id,
      });
      temporaryTab = activeTab;
    }
    catch(error) {
      log(`cannot open temporary window, fallback to an alert dialog. `, error);
    }
  }
  if (temporaryTab) {
    const code = `
      (() => {
        let richText = ${JSON.stringify(richText)};
        let plainText = ${JSON.stringify(plainText)};
        return (${doCopy.toString()})();
      })();
    `;
    const results = await browser.tabs.executeScript(temporaryTab.id, {
      matchAboutBlank: true,
      code
    }).catch(error => {
      log(`failed to execute code in the tab ${temporaryTab.id}`, error);
      return [];
    });
    if (temporaryWindow)
      await browser.windows.remove(temporaryWindow.id);
    else
      await browser.tabs.remove(temporaryTab.id);
    if (results[0]) {
      notifyCopied(tabs.length, plainText);
      return;
    }
  }

  log('failed to write rich text data to the clipboard, so fallback to plain text data copy via Clipboard API');
  try {
    navigator.clipboard.writeText(plainText)
      .then(() => {
        notifyCopied(tabs.length, plainText);
      })
      .catch(error => {
        notifyFailed(error);
      });
    return;
  }
  catch(error) {
    notifyFailed(error);
  }
}

export async function fillPlaceHolders(format, tab, indentLevel) {
  log('fillPlaceHolders ', tab.id, format, indentLevel);
  const now = new Date();
  let params = {
    tab,
    indentLevel,
    lineFeed:  configs.useCRLF ? '\r\n' : '\n',
    timeUTC:   now.toUTCString(),
    timeLocal: now.toLocaleString()
  };
  if (tab.discarded) {
    if (configs.reportErrors) {
      params.author      = browser.i18n.getMessage('error_discarded_author');
      params.description = browser.i18n.getMessage('error_discarded_description');
      params.keywords    = browser.i18n.getMessage('error_discarded_keywords');
    }
  }
  else if (!Permissions.isPermittedTab(tab)) {
    if (configs.reportErrors) {
      params.author      = browser.i18n.getMessage('error_unpermitted_author');
      params.description = browser.i18n.getMessage('error_unpermitted_description');
      params.keywords    = browser.i18n.getMessage('error_unpermitted_keywords');
    }
  }
  else if (/%(AUTHOR|DESC(?:RIPTION)?|KEYWORDS)(?:_HTML(?:IFIED)?)?%/i.test(format)) {
    log('trying to get data from content ', tab.id);
    try {
      let paramsFromContent = await browser.tabs.executeScript(tab.id, {
        file: '/common/get-content-text.js'
      });
      if (Array.isArray(paramsFromContent))
        paramsFromContent = paramsFromContent[0];
      params = { ...params, ...paramsFromContent };
    }
    catch(error) {
      console.log(`failed to get data from content `, tab.id, tab.url, error);
      if (configs.reportErrors) {
        const errorMessage = error instanceof Error ? `${String(error)}\n${error.stack}` : String(error);
        params.author      = browser.i18n.getMessage('error_failed_author', [errorMessage]);
        params.description = browser.i18n.getMessage('error_failed_description', [errorMessage]);
        params.keywords    = browser.i18n.getMessage('error_failed_keywords', [errorMessage]);
      }
    }
    log('params ', params);
  }

  try {
    const filled = fillPlaceHoldersInternal(format, params);

    if (/%RT%/i.test(format)) {
      return {
        richText:  filled.trim() && filled ||
                     `<a href="${sanitizeHtmlText(tab.url)}">${sanitizeHtmlText(tab.title)}</a>`,
        plainText: filled.trim() && filled ||
                     `${tab.title}<${tab.url}>`
      };
    }
    return {
      richText:  '',
      plainText: filled
    };
  }
  catch(error) {
    if (error instanceof Replacer.ReplacerError || error instanceof FunctionalPlaceHolder.FunctionalPlaceHolderError)
      return {
        richText:  '',
        plainText: error.message
      };

    console.error(error);
    return {
      richText:  '',
      plainText: error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    };
  }
}

function fillPlaceHoldersInternal(
  format,
  { tab, author, description, keywords, timeUTC, timeLocal, lineFeed, indentLevel } = {}
) {
  const replaced = Replacer.processAll(
    format,
    (input, ..._replacePairs) => fillPlaceHoldersInternal(input, { tab, author, description, keywords, timeUTC, timeLocal, lineFeed, indentLevel })
  );
  const filled = FunctionalPlaceHolder.processAll(replaced, {
    container_name:            (prefix, suffix) => tab.container ? `${prefix}${tab.container}${suffix}` : '',
    container_name_html:       (prefix, suffix) => sanitizeHtmlText(tab.container ? `${prefix}${tab.container}${suffix}` : ''),
    container_name_htmlified:  (prefix, suffix) => sanitizeHtmlText(tab.container ? `${prefix}${tab.container}${suffix}` : ''),
    container_title:           (prefix, suffix) => tab.container ? `${prefix}${tab.container}${suffix}` : '',
    container_title_html:      (prefix, suffix) => sanitizeHtmlText(tab.container ? `${prefix}${tab.container}${suffix}` : ''),
    container_title_htmlified: (prefix, suffix) => sanitizeHtmlText(tab.container ? `${prefix}${tab.container}${suffix}` : ''),
  });
  return filled
    .replace(/%(?:RLINK|RLINK_HTML(?:IFIED)?|SEL|SEL_HTML(?:IFIED)?)%/gi, '')
    .replace(/%URL%/gi, tab.url)
    .replace(/%(?:TITLE|TEXT)%/gi, tab.title)
    .replace(/%URL_HTML(?:IFIED)?%/gi, sanitizeHtmlText(tab.url))
    .replace(/%TITLE_HTML(?:IFIED)?%/gi, sanitizeHtmlText(tab.title))
    .replace(/%URL_MD?%/gi, sanitizeMdText(tab.url))
    .replace(/%URL_MD_LINK_TITLE?%/gi, sanitizeMdLinkTitleText(tab.url))
    .replace(/%(?:TITLE|TEXT)_MD%/gi, sanitizeMdText(tab.title))
    .replace(/%(?:TITLE|TEXT)_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(tab.title))
    .replace(/%CONTAINER_(?:NAME|TITLE)%/gi, tab.container ? `${tab.container}: ` : '')
    .replace(/%CONTAINER_(?:NAME|TITLE)_HTML(?:IFIED)%/gi, tab.container ? `${tab.container}: ` : '')
    .replace(/%CONTAINER_(?:NAME|TITLE)_MD%/gi, tab.container ? `${sanitizeMdText(tab.container)}: ` : '')
    .replace(/%CONTAINER_(?:NAME|TITLE)_MD_LINK_TITLE%/gi, tab.container ? `${sanitizeMdLinkTitleText(tab.container)}: ` : '')
    .replace(/%CONTAINER_URL%/gi, tab.container ? `ext+container:name=${tab.container}&url=${tab.url}` : tab.url)
    .replace(/%CONTAINER_URL_HTML(?:IFIED)%/gi, tab.container ? `ext+container:name=${tab.container}&url=${sanitizeHtmlText(tab.url)}` : sanitizeHtmlText(tab.url))
    .replace(/%AUTHOR%/gi, author || '')
    .replace(/%AUTHOR_HTML(?:IFIED)?%/gi, sanitizeHtmlText(author || ''))
    .replace(/%AUTHOR_MD%/gi, sanitizeMdText(author || ''))
    .replace(/%AUTHOR_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(author || ''))
    .replace(/%DESC(?:RIPTION)?%/gi, description || '')
    .replace(/%DESC(?:RIPTION)?_HTML(?:IFIED)?%/gi, sanitizeHtmlText(description || ''))
    .replace(/%DESC(?:RIPTION)?_MD%/gi, sanitizeMdText(description || ''))
    .replace(/%DESC(?:RIPTION)?_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(description || ''))
    .replace(/%KEYWORDS%/gi, keywords || '')
    .replace(/%KEYWORDS_HTML(?:IFIED)?%/gi, sanitizeHtmlText(keywords || ''))
    .replace(/%KEYWORDS_MD%/gi, sanitizeMdText(keywords || ''))
    .replace(/%KEYWORDS_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(keywords || ''))
    .replace(/%UTC_TIME%/gi, timeUTC)
    .replace(/%UTC_TIME_MD%/gi, sanitizeMdText(timeUTC))
    .replace(/%UTC_TIME_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(timeUTC))
    .replace(/%LOCAL_TIME%/gi, timeLocal)
    .replace(/%LOCAL_TIME_MD%/gi, sanitizeMdText(timeLocal))
    .replace(/%LOCAL_TIME_MD_LINK_TITLE%/gi, sanitizeMdLinkTitleText(timeLocal))
    .replace(/%TAB%/gi, '\t')
    .replace(/%EOL%/gi, lineFeed)
    .replace(/%RT%/gi, '')
    .replace(kFORMAT_MATCHER_TST_INDENT, matched => {
      let indenters = matched.replace(/^%TST_INDENT|%$/g, '');
      if (indenters == '') {
        indenters = ['  '];
      }
      else {
        indenters = indenters
          .match(kFORMAT_PARAMETER_MATCHER)
          .map(indenter => indenter.substring(1, indenter.length - 1))
          .reverse();
      }
      let indent = '';
      for (let i = 0; i < indentLevel; i++) {
        const indenter = indenters[Math.min(i, indenters.length - 1)];
        indent = `${indenter}${indent}`;
      }
      return indent;
    });
}

export function sanitizeHtmlText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sanitizeMdText(text) {
  return text.replace(/[-!"#$%&'()*+,./:;<=>?@^_`{|}~\[\\\]]/g, '\\$&');
}

export function sanitizeMdLinkTitleText(text) {
  return text.replace(/["'()&\\]/g, '\\$&');
}

async function notifyCopied(count, copied) {
  if (!configs.shouldNotifyResult)
    return;
  return notify({
    title:   browser.i18n.getMessage(count > 1 ? 'notification_copied_multiple_title' : 'notification_copied_title', [count]),
    message: browser.i18n.getMessage(count > 1 ? 'notification_copied_multiple_message' : 'notification_copied_message', [count, copied])
  });
}

async function notifyFailed(error) {
  log('failed to write text/data to clipboard: ', error);
  if (!configs.shouldNotifyResult)
    return;
  notify({
    title:   browser.i18n.getMessage('notification_failedToCopy_title'),
    message: browser.i18n.getMessage('notification_failedToCopy_message', [String(error)])
  });
}
