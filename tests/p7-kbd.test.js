'use strict';
// P7.4 应用内键盘快捷键：目标可编辑判定、按键映射纯函数、Esc 逐层关闭、
// 周期翻页 navPeriod（含月历分支）、帮助浮层开合
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 单键事件速记（未给出的修饰键均为 undefined = falsy）
const key = (k, extra) => Object.assign({ key: k, ctrlKey: false, altKey: false, metaKey: false, isComposing: false }, extra);

test('isEditableTarget：输入类元素/内容可编辑为 true，普通元素与空值为 false', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `isEditableTarget({ tagName: 'INPUT' })`), true);
  assert.strictEqual(appEval(sb, `isEditableTarget({ tagName: 'TEXTAREA' })`), true);
  assert.strictEqual(appEval(sb, `isEditableTarget({ tagName: 'select' })`), true);
  assert.strictEqual(appEval(sb, `isEditableTarget({ tagName: 'DIV', isContentEditable: true })`), true);
  assert.strictEqual(appEval(sb, `isEditableTarget({ tagName: 'DIV' })`), false);
  assert.strictEqual(appEval(sb, `isEditableTarget(null)`), false);
});

test('kbdActionOf：键位映射（N/1-4/方向/Esc/?/Ctrl+F）', () => {
  const { sb } = loadApp();
  const act = (o) => hostify(appEval(sb, `kbdActionOf(${JSON.stringify(o)})`));
  assert.strictEqual(act(key('n')), 'quickadd');
  assert.strictEqual(act(key('N')), 'quickadd');
  assert.strictEqual(act(key('1')), 'view1');
  assert.strictEqual(act(key('2')), 'view2');
  assert.strictEqual(act(key('3')), 'view3');
  assert.strictEqual(act(key('4')), 'view4');
  assert.strictEqual(act(key('ArrowLeft')), 'prev');
  assert.strictEqual(act(key('ArrowRight')), 'next');
  assert.strictEqual(act(key('Escape')), 'esc');
  assert.strictEqual(act(key('?')), 'help');
  assert.strictEqual(act(key('f', { ctrlKey: true })), 'search');
  assert.strictEqual(act(key('F', { ctrlKey: true })), 'search');
});

test('kbdActionOf：组字中/修饰键/普通字符排除', () => {
  const { sb } = loadApp();
  const act = (o) => hostify(appEval(sb, `kbdActionOf(${JSON.stringify(o)})`));
  assert.strictEqual(act(key('n', { isComposing: true })), '', '输入法组字中不处理');
  assert.strictEqual(act(key('1', { altKey: true })), '', 'Alt 组合不处理');
  assert.strictEqual(act(key('1', { metaKey: true })), '', 'Meta 组合不处理');
  assert.strictEqual(act(key('n', { ctrlKey: true })), '', 'Ctrl+非F 不处理');
  assert.strictEqual(act(key('x')), '', '普通字符不处理');
  assert.strictEqual(hostify(appEval(sb, 'kbdActionOf(null)')), '', '空事件不处理');
});

test('escClose：帮助浮层最高优先（remove 被调用）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    window.__removed = 0;
    document.querySelector = () => ({ remove() { window.__removed++; } });
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), 'help');
  assert.strictEqual(hostify(appEval(sb, 'window.__removed')), 1);
});

test('escClose：打开的表单层（模拟点取消）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    window.__clicked = 0;
    document.querySelector = (sel) => {
      if (sel === '.kbd-help-mask') return null;
      if (sel.indexOf('add-form') >= 0 || sel.indexOf('project-form') >= 0 || sel.indexOf('editor-block') >= 0) {
        return { classList: { contains: () => false }, querySelector: (s) => (s === '.cancel' ? { click() { window.__clicked++; } } : null) };
      }
      return null;
    };
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), 'form');
  assert.strictEqual(hostify(appEval(sb, 'window.__clicked')), 1);
});

test('escClose：editor-block 编辑块进入内层表单找取消按钮', () => {
  const { sb } = loadApp();
  appEval(sb, `
    window.__clicked = 0;
    document.querySelector = (sel) => {
      if (sel === '.kbd-help-mask') return null;
      if (sel.indexOf('editor-block') >= 0) {
        return {
          classList: { contains: (c) => c === 'editor-block' },
          querySelector: (s) => (s === '.add-form' ? { querySelector: (s2) => (s2 === '.cancel' ? { click() { window.__clicked++; } } : null) } : null)
        };
      }
      return null;
    };
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), 'form');
  assert.strictEqual(hostify(appEval(sb, 'window.__clicked')), 1);
});

test('escClose：工具层（currentTool 清空）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    document.querySelector = () => null;
    currentTool = 'search';
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), 'tool');
  assert.strictEqual(hostify(appEval(sb, 'currentTool')), null);
});

test('escClose：弹出菜单层（hideCtxMenu 清空挂起动作）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    document.querySelector = () => null;
    currentTool = null;
    ctxMenu.classList.contains = () => false;   // 桩恒为 false：假装菜单可见
    pendingDateAction = 'noop';
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), 'menu');
  assert.strictEqual(hostify(appEval(sb, 'pendingDateAction')), null);
});

test('escClose：无层级可关返回空串', () => {
  const { sb } = loadApp();
  appEval(sb, `
    document.querySelector = () => null;
    currentTool = null;
    ctxMenu.classList.contains = () => true;   // 假装菜单隐藏
  `);
  assert.strictEqual(hostify(appEval(sb, 'escClose()')), '');
});

test('navPeriod：月历模式翻月并收起展开格', () => {
  const { sb } = loadApp();
  appEval(sb, `
    calendarMode = 'month';
    monthAnchor = new Date(2026, 9, 15);
    monthExpandKey = '2026-10-11';
  `);
  appEval(sb, 'navPeriod(-1)');
  assert.strictEqual(hostify(appEval(sb, 'monthAnchor.getMonth()')), 8, '10 月 → 9 月');
  assert.strictEqual(hostify(appEval(sb, 'monthExpandKey')), '');
  appEval(sb, 'navPeriod(1); navPeriod(1)');
  assert.strictEqual(hostify(appEval(sb, 'monthAnchor.getMonth()')), 10, '9 月 → 11 月');
});

test('navPeriod：普通模式按页长平移 rangeStart', () => {
  const { sb } = loadApp();
  appEval(sb, `
    calendarMode = 'calendar';
    rangeStart = new Date(2026, 9, 11);
  `);
  appEval(sb, 'navPeriod(1)');
  assert.strictEqual(hostify(appEval(sb, 'dateKey(rangeStart)')), '2026-10-18', '下周日（步长 7）');
  appEval(sb, 'navPeriod(-1)');
  assert.strictEqual(hostify(appEval(sb, 'dateKey(rangeStart)')), '2026-10-11', '回到本周日');
});

test('帮助浮层：toggle 打开挂到 body 且含键位文案；再开即关', () => {
  const { sb } = loadApp();
  appEval(sb, 'document.querySelector = () => null;');   // 无已开浮层 → 走创建分支
  appEval(sb, 'toggleKbdHelp()');
  const n = hostify(appEval(sb, 'document.body.children.length'));
  assert.ok(n >= 1, '浮层已挂到 body');
  const html = hostify(appEval(sb, 'document.body.children[document.body.children.length - 1].innerHTML'));
  assert.ok(html.includes('键盘快捷键'), '标题');
  assert.ok(html.includes('1 / 2 / 3 / 4') && html.includes('今日 / 项目 / 事项 / 日历'), '视图分组');
  assert.ok(html.includes('Ctrl+F') && html.includes('快速新建事项'), '事项分组');
  assert.ok(html.includes('kbd-help-close'), '关闭按钮');
  assert.ok(html.includes('逐层关闭'), 'Esc 说明');
  // 二次 toggle：querySelector 返回已有浮层 → 走关闭分支
  appEval(sb, `
    window.__helpRemoved = 0;
    const __mask = document.body.children[document.body.children.length - 1];
    __mask.remove = () => { window.__helpRemoved++; };
    document.querySelector = () => __mask;
  `);
  appEval(sb, 'toggleKbdHelp()');
  assert.strictEqual(hostify(appEval(sb, 'window.__helpRemoved')), 1, '二次 toggle 关闭浮层');
});
