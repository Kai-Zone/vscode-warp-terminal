/**
 * WarpInputBarManager 单元测试套件
 *
 * 验证 Warp 风格底部固定输入框的核心行为：
 * 1. 终端挂载与 DOM 结构生成（卡片、提示符、输入框、执行按钮）；
 * 2. 回车执行命令（调用 input 消息通道，带 \r 换行，清空输入框，写入历史）；
 * 3. 避免 IME 输入法合成期回车被误触发；
 * 4. 上下箭头键历史命令回溯；
 * 5. Ctrl+C 发送 SIGINT 中断与 Ctrl+L 清屏；
 * 6. 解绑与资源释放清理。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WarpInputBarManager } from '../../../../../../src/webview/managers/WarpInputBarManager';
import type { IManagerCoordinator } from '../../../../../../src/webview/interfaces/ManagerInterfaces';

describe('WarpInputBarManager', () => {
  let manager: WarpInputBarManager;
  let mockCoordinator: IManagerCoordinator;
  let mockPostMessage: ReturnType<typeof vi.fn>;
  let mockSendInput: ReturnType<typeof vi.fn>;
  let container: HTMLElement;
  let terminalContent: HTMLElement;
  let mockTerminal: any;

  beforeEach(() => {
    // 准备测试 DOM
    document.body.innerHTML = '';
    const styleElem = document.getElementById('warp-input-bar-styles');
    if (styleElem) {
      styleElem.remove();
    }

    container = document.createElement('div');
    container.className = 'terminal-container';
    container.setAttribute('data-terminal-id', 'term-1');

    terminalContent = document.createElement('div');
    terminalContent.className = 'terminal-content';
    container.appendChild(terminalContent);
    document.body.appendChild(container);

    mockPostMessage = vi.fn();
    mockSendInput = vi.fn();
    const mockFlushOutputBuffer = vi.fn();

    mockTerminal = {
      cols: 80,
      rows: 24,
      buffer: {
        active: { cursorY: 0, baseY: 0 },
      },
      fitAddon: {
        fit: vi.fn(),
      },
      refresh: vi.fn(),
      scrollToBottom: vi.fn(),
    };

    mockCoordinator = {
      getTerminalInstance: vi.fn((id: string) => {
        if (id === 'term-1') {
          return {
            id: 'term-1',
            terminal: mockTerminal,
            container,
            fitAddon: mockTerminal.fitAddon,
          } as any;
        }
        return undefined;
      }),
      getAllTerminalInstances: vi.fn(() => new Map()),
      setActiveTerminalId: vi.fn(),
      postMessageToExtension: mockPostMessage,
      getMessageManager: vi.fn(() => ({
        sendInput: mockSendInput,
      })) as any,
      getManagers: vi.fn(() => ({
        performance: {
          flushOutputBuffer: mockFlushOutputBuffer,
        },
      })) as any,
    } as unknown as IManagerCoordinator;

    manager = new WarpInputBarManager(mockCoordinator);
    manager.initialize();
  });

  afterEach(() => {
    manager.dispose();
    document.body.innerHTML = '';
  });

  it('挂载终端时应生成完整的 Warp 风格输入框 DOM 结构', () => {
    manager.attachTerminal('term-1');

    const inputBar = container.querySelector('.warp-input-bar') as HTMLElement;
    expect(inputBar).not.toBeNull();
    expect(inputBar.getAttribute('data-terminal-id')).toBe('term-1');

    const card = inputBar.querySelector('.warp-input-card') as HTMLElement;
    expect(card).not.toBeNull();

    const badge = card.querySelector('.warp-prompt-badge') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('❯');

    const input = card.querySelector('.warp-input-field') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('输入命令并回车执行...');

    const runButton = card.querySelector('.warp-run-button') as HTMLButtonElement;
    expect(runButton).not.toBeNull();
    expect(runButton.textContent).toBe('⏎');

    // terminalContent 应被调整为 flex: 1 1 0% 自适应
    expect(terminalContent.style.flex).toBe('1 1 0%');
  });

  it('输入命令后按回车应通过 input 协议发送命令加换行符并清空输入框', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    input.value = 'ls -la';
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);

    expect(mockSendInput).toHaveBeenCalledWith('ls -la\r', 'term-1');
    expect(input.value).toBe('');
    expect(manager.getHistory('term-1')).toEqual(['ls -la']);
  });

  it('在输入法合成期间 (isComposing) 按回车不应执行命令', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    input.value = 'ceshi';
    const composingEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composingEnterEvent);

    expect(mockSendInput).not.toHaveBeenCalled();
    expect(input.value).toBe('ceshi');
    expect(manager.getHistory('term-1')).toEqual([]);
  });

  it('点击执行按钮应执行当前输入的命令', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;
    const runBtn = container.querySelector('.warp-run-button') as HTMLButtonElement;

    input.value = 'git status';
    runBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mockSendInput).toHaveBeenCalledWith('git status\r', 'term-1');
    expect(input.value).toBe('');
  });

  it('上下箭头键应能在历史命令中前后切换', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    // 执行两条历史命令
    input.value = 'npm run build';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    input.value = 'npm test';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(manager.getHistory('term-1')).toEqual(['npm run build', 'npm test']);

    // 按上箭头：回溯到上一条 "npm test"
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(input.value).toBe('npm test');

    // 再按上箭头：回溯到 "npm run build"
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(input.value).toBe('npm run build');

    // 按下箭头：回到 "npm test"
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(input.value).toBe('npm test');

    // 再按下箭头：恢复空输入
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(input.value).toBe('');
  });

  it('Ctrl+C 应向终端发送 \\x03 (SIGINT) 中断信号并清空输入', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    input.value = 'ping google.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));

    expect(mockSendInput).toHaveBeenCalledWith('\x03', 'term-1');
    expect(input.value).toBe('');
  });

  it('Ctrl+L 应向终端发送 \\x0c 清屏信号', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));

    expect(mockSendInput).toHaveBeenCalledWith('\x0c', 'term-1');
  });

  it('点击输入框底栏区域应聚焦输入框并阻止事件冒泡', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;
    const inputFocusSpy = vi.spyOn(input, 'focus');

    const inputBar = container.querySelector('.warp-input-bar') as HTMLElement;
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stopPropSpy = vi.spyOn(clickEvent, 'stopPropagation');

    inputBar.dispatchEvent(clickEvent);

    expect(stopPropSpy).toHaveBeenCalled();
    expect(inputFocusSpy).toHaveBeenCalled();
  });

  it('xterm-helper-textarea 获取焦点时应自动重定向至底部 Warp 输入框', () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    container.appendChild(textarea);

    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;
    const inputFocusSpy = vi.spyOn(input, 'focus');

    textarea.dispatchEvent(new FocusEvent('focus'));

    expect(inputFocusSpy).toHaveBeenCalled();
  });

  it('解绑 detachTerminal 时应移除 DOM 并清理状态', () => {
    manager.attachTerminal('term-1');
    expect(container.querySelector('.warp-input-bar')).not.toBeNull();
    expect(manager.hasInputBar('term-1')).toBe(true);

    manager.detachTerminal('term-1');
    expect(container.querySelector('.warp-input-bar')).toBeNull();
    expect(manager.getInputElement('term-1')).toBeUndefined();
    expect(manager.hasInputBar('term-1')).toBe(false);
  });

  it('hasInputBar 应准确返回指定终端是否已挂载底部输入框', () => {
    expect(manager.hasInputBar('unknown-term')).toBe(false);
    manager.attachTerminal('term-1');
    expect(manager.hasInputBar('term-1')).toBe(true);
    expect(manager.hasInputBar('term-2')).toBe(false);
  });

  it('挂载终端时应触发终端尺寸调整并向扩展端同步 resize 消息', () => {
    manager.attachTerminal('term-1');

    expect(mockTerminal.fitAddon.fit).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'resize',
        terminalId: 'term-1',
        cols: 80,
        rows: 24,
      })
    );
    expect(mockTerminal.scrollToBottom).toHaveBeenCalled();
  });

  it('执行命令时应主动刷新输出缓冲区并触发终端视口滚动到底部', () => {
    manager.attachTerminal('term-1');
    const input = manager.getInputElement('term-1')!;

    input.value = 'npm start';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const perfManager = mockCoordinator.getManagers().performance;
    expect(perfManager.flushOutputBuffer).toHaveBeenCalled();
    expect(mockTerminal.scrollToBottom).toHaveBeenCalled();
    expect(mockSendInput).toHaveBeenCalledWith('npm start\r', 'term-1');
  });

  it('解绑 detachTerminal 时应触发重新调整尺寸并同步 resize 消息', () => {
    manager.attachTerminal('term-1');
    mockPostMessage.mockClear();

    manager.detachTerminal('term-1');

    expect(mockTerminal.fitAddon.fit).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'resize',
        terminalId: 'term-1',
        cols: 80,
        rows: 24,
      })
    );
  });

  describe('多行输入与换行支持', () => {
    it('输入框应采用 textarea 元素以支持多行输入', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;
      expect(input.tagName.toLowerCase()).toBe('textarea');
    });

    it('按下 Shift+Enter 时应在光标处插入换行符并阻止冒泡，不触发命令执行', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      input.value = 'echo "line 1"';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;

      const shiftEnterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(shiftEnterEvent, 'preventDefault');
      const stopSpy = vi.spyOn(shiftEnterEvent, 'stopPropagation');

      input.dispatchEvent(shiftEnterEvent);

      // 应插入换行符且光标移动到末尾
      expect(input.value).toBe('echo "line 1"\n');
      expect(input.selectionStart).toBe('echo "line 1"\n'.length);
      // 应阻止默认行为与冒泡，且不应触发命令执行
      expect(preventSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
      expect(mockSendInput).not.toHaveBeenCalled();
    });

    it('按下 Alt+Enter 时应在光标处插入换行符并阻止冒泡，不触发命令执行', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      input.value = 'echo "line 1"';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;

      const altEnterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(altEnterEvent, 'preventDefault');
      const stopSpy = vi.spyOn(altEnterEvent, 'stopPropagation');

      input.dispatchEvent(altEnterEvent);

      expect(input.value).toBe('echo "line 1"\n');
      expect(preventSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
      expect(mockSendInput).not.toHaveBeenCalled();
    });

    it('在文本中间按下 Shift+Enter 时应在当前光标位置正确分行', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      input.value = 'firstsecond';
      input.selectionStart = 5; // 'first' 后面
      input.selectionEnd = 5;

      const shiftEnterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      input.dispatchEvent(shiftEnterEvent);

      expect(input.value).toBe('first\nsecond');
      expect(input.selectionStart).toBe(6);
      expect(input.selectionEnd).toBe(6);
      expect(mockSendInput).not.toHaveBeenCalled();
    });

    it('执行多行命令时，应将换行符标准化为终端标准回车序列逐行发送', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      input.value = 'echo "first line"\necho "second line"';
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });

      input.dispatchEvent(enterEvent);
      // 多行命令发送时换行符转化为终端换行并以回车结尾
      expect(mockSendInput).toHaveBeenCalledWith(
        'echo "first line"\recho "second line"\r',
        'term-1'
      );
      expect(input.value).toBe('');
    });

    it('多行文本时光标不在首行按 ArrowUp 应在文本内移动光标，不触发历史回溯', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      // 先执行一条历史命令
      input.value = 'first-cmd';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      // 输入两行内容，并将光标置于第二行
      input.value = 'line 1\nline 2';
      // 光标放在第二行
      input.selectionStart = 10;
      input.selectionEnd = 10;

      const upEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      const dispatched = input.dispatchEvent(upEvent);

      // 光标在非首行，不应阻止默认行为，不应被历史命令覆盖
      expect(dispatched).toBe(true);
      expect(input.value).toBe('line 1\nline 2');
    });

    it('多行文本时光标在首行按 ArrowUp 时应触发历史命令回溯', () => {
      manager.attachTerminal('term-1');
      const input = manager.getInputElement('term-1')!;

      // 先执行一条历史命令
      input.value = 'previous-history-cmd';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      // 当前输入框为多行，但光标在第一行
      input.value = 'line 1\nline 2';
      input.selectionStart = 3;
      input.selectionEnd = 3;

      const upEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(upEvent);

      // 光标在首行，触发历史命令切换
      expect(input.value).toBe('previous-history-cmd');
    });
  });
});
