// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Script of the repository groups editor (src/vscode/repositoryGroupsEditor.ts). It only shows the entries and sends
// them to the extension, which checks them, builds the preview with the code of the sidebar, and writes the setting.
// Texts from the extension are always set as text, never as HTML.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const FLAGS = [
    { flag: 'i', label: 'i', title: 'Ignore case' },
    { flag: 'u', label: 'u', title: 'Unicode' },
    { flag: 's', label: 's', title: 'Dot matches line breaks' },
  ];
  const UPDATE_DELAY_MS = 150;

  /** @type {{name: string, pattern: string, flags: string}[]} */
  let entries = [];
  let seq = 0;
  /** The load of the extension that the entries come from; sent back with each update. */
  let generation = 0;
  let timer = undefined;
  let lastState = undefined;
  /** Open state of the preview nodes that the user changed, by owner and label path. */
  const openNodes = new Map();

  const $ = (id) => document.getElementById(id);
  const list = $('entries');

  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  function send(message) {
    vscode.postMessage(message);
  }

  function entriesForMessage() {
    return entries.map((entry) => ({ name: entry.name, pattern: entry.pattern, flags: entry.flags }));
  }

  function sendUpdate() {
    clearTimeout(timer);
    timer = undefined;
    seq += 1;
    send({ type: 'update', seq, generation, entries: entriesForMessage(), testName: $('test-name').value });
  }

  function scheduleUpdate() {
    clearTimeout(timer);
    timer = setTimeout(sendUpdate, UPDATE_DELAY_MS);
  }

  function normalizeFlags(flags) {
    return FLAGS.map((item) => item.flag)
      .filter((flag) => flags.includes(flag))
      .join('');
  }

  // ---- Entries ------------------------------------------------------------------------------------------------

  function renderEntries(focus) {
    list.replaceChildren(...entries.map((entry, index) => entryRow(entry, index)));
    $('no-entries').hidden = entries.length > 0;
    if (lastState) applyChecks(lastState);
    if (focus) {
      const target = document.getElementById(focus);
      if (target && !target.disabled) target.focus();
      else $('add').focus();
    }
  }

  function entryRow(entry, index) {
    const position = index + 1;
    const id = (part) => `entry-${index}-${part}`;
    const nameInput = el('input', {
      type: 'text',
      id: id('name'),
      value: entry.name,
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: 200,
      placeholder: 'No node',
    });
    nameInput.value = entry.name;
    nameInput.addEventListener('input', () => {
      entries[index].name = nameInput.value;
      scheduleUpdate();
    });
    const patternInput = el('input', {
      type: 'text',
      id: id('pattern'),
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: 5000,
      'aria-describedby': `${id('error')} ${id('note')}`,
      placeholder: '^(\\d{4})-(.+)$',
    });
    patternInput.value = entry.pattern;
    patternInput.addEventListener('input', () => {
      entries[index].pattern = patternInput.value;
      scheduleUpdate();
    });
    const flagBoxes = FLAGS.map((item) => {
      const box = el('input', { type: 'checkbox', id: id(`flag-${item.flag}`), checked: entry.flags.includes(item.flag) });
      box.checked = entry.flags.includes(item.flag);
      box.addEventListener('change', () => {
        const current = entries[index].flags.replace(item.flag, '');
        entries[index].flags = normalizeFlags(box.checked ? current + item.flag : current);
        sendUpdate();
      });
      return el('span', {}, [box, el('label', { for: id(`flag-${item.flag}`), text: ` ${item.label} (${item.title})` })]);
    });
    const button = (part, text, label, disabled, action, secondary) => {
      const node = el('button', { type: 'button', id: id(part), 'aria-label': label, className: secondary ? 'secondary' : undefined, disabled, text });
      node.addEventListener('click', action);
      return node;
    };
    const buttons = el('div', { className: 'row-buttons' }, [
      button('up', 'Up', `Move entry ${position} up`, index === 0, () => move(index, -1), true),
      button('down', 'Down', `Move entry ${position} down`, index === entries.length - 1, () => move(index, 1), true),
      button('remove', 'Remove', `Remove entry ${position}`, false, () => remove(index), true),
    ]);
    return el('li', { className: 'entry' }, [
      el('fieldset', {}, [
        el('legend', { text: `Entry ${position}` }),
        el('div', { className: 'fields' }, [
          el('div', { className: 'field' }, [el('label', { for: id('name'), text: 'Name (optional)' }), nameInput]),
          el('div', { className: 'field' }, [el('label', { for: id('pattern'), text: 'Regular expression' }), patternInput]),
        ]),
        el('div', { className: 'row-bottom' }, [
          el('fieldset', { className: 'flags' }, [el('legend', { text: 'Flags:' }), ...flagBoxes]),
          buttons,
        ]),
        el('p', { className: 'error', id: id('error'), 'aria-live': 'polite' }),
        el('p', { className: 'note', id: id('note') }),
      ]),
    ]);
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const [entry] = entries.splice(index, 1);
    entries.splice(target, 0, entry);
    const part = delta < 0 ? (target === 0 ? 'down' : 'up') : target === entries.length - 1 ? 'up' : 'down';
    renderEntries(`entry-${target}-${part}`);
    sendUpdate();
  }

  function remove(index) {
    entries.splice(index, 1);
    const next = Math.min(index, entries.length - 1);
    renderEntries(next >= 0 ? `entry-${next}-pattern` : 'add');
    sendUpdate();
  }

  $('add').addEventListener('click', () => {
    entries.push({ name: '', pattern: '', flags: '' });
    renderEntries(`entry-${entries.length - 1}-pattern`);
    sendUpdate();
  });

  $('save').addEventListener('click', () => {
    clearTimeout(timer);
    timer = undefined;
    seq += 1;
    send({ type: 'save', seq, generation, entries: entriesForMessage() });
  });
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));
  $('reload').addEventListener('click', () => send({ type: 'reload' }));
  $('test-name').addEventListener('input', scheduleUpdate);

  // A hidden tab loses this page: the last change goes to the extension first, which keeps the draft.
  function flushUpdate() {
    if (timer !== undefined) sendUpdate();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushUpdate();
  });
  window.addEventListener('pagehide', flushUpdate);

  // ---- State from the extension ------------------------------------------------------------------------------

  function applyChecks(state) {
    entries.forEach((_entry, index) => {
      const check = state.checks[index] || {};
      const error = document.getElementById(`entry-${index}-error`);
      const note = document.getElementById(`entry-${index}-note`);
      const pattern = document.getElementById(`entry-${index}-pattern`);
      if (error) error.textContent = check.error || '';
      if (note) note.textContent = check.error ? '' : check.note || '';
      if (pattern) pattern.setAttribute('aria-invalid', check.error ? 'true' : 'false');
    });
  }

  function applyState(state) {
    // An answer to an older update: the entries changed since; the next answer follows.
    if (state.seq < seq && state.checks.length !== entries.length) return;
    lastState = state;
    applyChecks(state);
    $('save').disabled = !state.canSave || !state.dirty;
    $('changed').hidden = !state.changedOutside;
    $('status').textContent = state.status || (state.dirty ? 'Not saved.' : '');
    renderTest(state.test);
    renderPreview(state.preview);
  }

  function renderTest(test) {
    const box = $('test-result');
    if (!test) {
      box.replaceChildren();
      return;
    }
    const children = [el('p', { text: test.text })];
    if (test.path.length > 0) {
      children.push(el('p', {}, [el('span', { text: 'Place in the view: ' }), el('span', { className: 'path', text: test.path.join(' › ') })]));
    }
    box.replaceChildren(...children);
  }

  function renderPreview(preview) {
    const box = $('preview');
    if (preview.tooSlow) {
      box.replaceChildren(
        el('p', { className: 'error', text: 'The preview was stopped: the regular expressions took more than 1 second for the repository names of the view.' }),
      );
      return;
    }
    if (!preview.loaded) {
      box.replaceChildren(el('p', { className: 'muted', text: 'No repositories are loaded in the Dev Environments view yet. Open the view and sign in to see a preview.' }));
      return;
    }
    if (preview.owners.length === 0) {
      box.replaceChildren(el('p', { className: 'muted', text: 'The Dev Environments view lists no repositories.' }));
      return;
    }
    const sections = preview.owners.map((owner) => ownerSection(owner));
    if (preview.truncated > 0) sections.push(el('p', { className: 'muted', text: `${preview.truncated} more nodes are not shown.` }));
    box.replaceChildren(...sections);
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function ownerSection(owner) {
    const parts = [];
    if (owner.grouped) {
      const counts = owner.counts.map((count, index) => `entry ${index + 1}: ${count}`);
      counts.push(`no match: ${owner.unmatched}`);
      parts.push(el('p', { className: 'counts', text: `${plural(owner.total, 'repository', 'repositories')} · ${counts.join(' · ')}` }));
    } else {
      parts.push(
        el('p', {
          className: 'counts',
          text: `${plural(owner.total, 'repository', 'repositories')}. No repository matches an entry: the owner keeps its plain list.`,
        }),
      );
    }
    parts.push(treeList(owner.owner, owner.tree, []));
    if (owner.keptWithEnvironment.length > 0) {
      parts.push(
        el('p', {
          className: 'hidden-list',
          text: `Shown although they match no entry, because they have an environment: ${owner.keptWithEnvironment.join(', ')}`,
        }),
      );
    }
    if (owner.hidden.length > 0) {
      const key = `hidden\u001f${owner.owner}`;
      const details = el('details', { open: openNodes.get(key) === true }, [
        el('summary', { text: `Hidden: ${plural(owner.hidden.length, 'repository', 'repositories')}` }),
        el('ul', { className: 'hidden-list' }, owner.hidden.map((name) => el('li', { text: name }))),
      ]);
      details.addEventListener('toggle', () => openNodes.set(key, details.open));
      parts.push(details);
    }
    return el('section', { 'aria-label': `Owner ${owner.owner}` }, [el('h3', { text: owner.owner }), ...parts]);
  }

  function treeList(owner, nodes, path) {
    return el(
      'ul',
      { className: path.length === 0 ? 'tree' : undefined },
      nodes.map((node) => treeItem(owner, node, path)),
    );
  }

  function treeItem(owner, node, path) {
    if (node.kind === 'group') {
      const nodePath = path.concat(node.label);
      const key = `${owner}\u001f${nodePath.join('\u001f')}`;
      const open = openNodes.has(key) ? openNodes.get(key) : node.expanded === true;
      const summary = el('summary', {}, [
        el('span', { className: 'group-label', text: node.label }),
        node.detail ? el('span', { className: 'detail', text: node.detail }) : undefined,
        el('span', { className: 'detail', text: `(${countRows(node)})` }),
      ]);
      const details = el('details', { open }, [summary, treeList(owner, node.children || [], nodePath)]);
      details.addEventListener('toggle', () => openNodes.set(key, details.open));
      return el('li', {}, [details]);
    }
    if (node.kind === 'hint') return el('li', { className: 'leaf hint', text: node.label });
    return el('li', { className: 'leaf' }, [
      el('span', { text: node.label }),
      node.detail ? el('span', { className: 'detail', text: node.detail }) : undefined,
      node.environment ? el('span', { className: 'env', text: '(environment)' }) : undefined,
    ]);
  }

  function countRows(node) {
    if (node.kind !== 'group') return node.kind === 'repository' ? 1 : 0;
    return (node.children || []).reduce((sum, child) => sum + countRows(child), 0);
  }

  function renderNotices(notices) {
    $('notices').replaceChildren(...notices.map((text) => el('p', { className: 'notice', text })));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'load' && Array.isArray(message.entries)) {
      clearTimeout(timer);
      timer = undefined;
      entries = message.entries.map((entry) => ({
        name: String(entry.name),
        pattern: String(entry.pattern),
        flags: normalizeFlags(String(entry.flags)),
      }));
      lastState = undefined;
      if (typeof message.generation === 'number') generation = message.generation;
      if (typeof message.testName === 'string') $('test-name').value = message.testName;
      renderNotices(Array.isArray(message.notices) ? message.notices.map(String) : []);
      renderEntries();
    } else if (message.type === 'state') {
      applyState(message);
    }
  });

  send({ type: 'ready' });
})();
