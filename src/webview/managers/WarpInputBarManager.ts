/**
 * Warp 风格固定输入栏管理器 (WarpInputBarManager)
 *
 * 核心职责：
 * 1. 在终端视口最底部固定呈现 Warp 风格现代命令输入卡片（Docked Input Bar）；
 * 2. 彻底解决原生 xterm "两头输入/双光标割裂" 问题，隐藏视口闪烁光标，将输入统一收敛于底部输入框；
 * 3. 适配 VS Code 主题色彩系统（深色底色、聚焦发光边框、精致提示符 ❯、圆角卡片）；
 * 4. 真正执行命令：监听回车（支持 IME 中文输入法合成防误触），通过标准 input 协议发送 `command + '\r'`；
 * 5. 命令历史记录管理：支持上下箭头键（ArrowUp/ArrowDown）快速回溯与切换历史命令；
 * 6. 支持快捷键（Ctrl+C 发送 SIGINT 中断、Ctrl+L 清屏）与点击终端区域自动聚焦底部输入框。
 */

import { BaseManager } from './BaseManager';
import type { IManagerCoordinator, IWarpInputBarManager } from '../interfaces/ManagerInterfaces';
import { DOMUtils } from '../utils/DOMUtils';

/**
 * 单个终端输入栏运行时状态
 */
interface TerminalInputBarState {
  barElement: HTMLElement;
  inputElement: HTMLTextAreaElement;
  runButton: HTMLButtonElement;
  history: string[];
  historyIndex: number;
  disposables: Array<() => void>;
  resizeObserver: ResizeObserver | null;
}

/**
 * 全局注入样式文本
 */
const WARP_INPUT_BAR_CSS = `
  /* 确保终端容器采用列向 Flex 布局 */
  .terminal-container {
    display: flex !important;
    flex-direction: column !important;
    height: 100% !important;
    overflow: hidden !important;
  }

  /* 让终端内容展示区自适应撑满上方剩余空间，留出底部输入栏 */
  .terminal-container .terminal-content {
    flex: 1 1 0% !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: hidden !important;
  }

  /* 隐藏 xterm 自身的闪烁光标，彻底避免上下双输入点的视觉混乱 */
  .terminal-container .xterm .xterm-cursor-layer {
    display: none !important;
  }

  /* Warp 底部固定输入栏外层容器 */
  .warp-input-bar {
    display: flex !important;
    flex-direction: column !important;
    flex: 0 0 auto !important;
    width: 100% !important;
    padding: 8px 12px !important;
    background: var(--vscode-editor-background, #1e1e1e) !important;
    border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2)) !important;
    box-sizing: border-box !important;
    z-index: 20 !important;
  }

  /* Warp 风格输入卡片 (Pill/Box)，顶部对齐以适配多行扩展 */
  .warp-input-card {
    display: flex !important;
    align-items: flex-start !important;
    gap: 8px !important;
    background: var(--vscode-input-background, #252526) !important;
    border: 1px solid var(--vscode-input-border, #3c3c3c) !important;
    border-radius: 6px !important;
    padding: 6px 10px !important;
    box-sizing: border-box !important;
    transition: border-color 0.15s ease, box-shadow 0.15s ease !important;
  }

  /* 聚焦发光高亮 */
  .warp-input-card:focus-within,
  .warp-input-card.focused {
    border-color: var(--vscode-focusBorder, #007acc) !important;
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc) !important;
  }

  /* Warp 终端提示符徽标 ❯ */
  .warp-prompt-badge {
    color: var(--vscode-terminal-ansiCyan, #4ec9b0) !important;
    font-weight: 700 !important;
    font-size: 14px !important;
    line-height: 20px !important;
    user-select: none !important;
    flex-shrink: 0 !important;
    padding-top: 1px !important;
  }

  /* 多行文本输入框 */
  .warp-input-field {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    background: transparent !important;
    border: none !important;
    outline: none !important;
    resize: none !important;
    overflow-y: hidden !important;
    min-height: 20px !important;
    max-height: 160px !important;
    color: var(--vscode-input-foreground, #cccccc) !important;
    font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace)) !important;
    font-size: var(--vscode-editor-font-size, 13px) !important;
    line-height: 20px !important;
    caret-color: var(--vscode-focusBorder, #007acc) !important;
    padding: 0 !important;
    margin: 0 !important;
    white-space: pre-wrap !important;
    word-break: break-all !important;
    box-sizing: border-box !important;
  }

  .warp-input-field::placeholder {
    color: var(--vscode-input-placeholderForeground, rgba(204, 204, 204, 0.4)) !important;
    opacity: 1 !important;
  }

  /* 执行按钮 */
  .warp-run-button {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    background: transparent !important;
    border: 1px solid transparent !important;
    color: var(--vscode-foreground, #cccccc) !important;
    opacity: 0.65 !important;
    border-radius: 4px !important;
    padding: 2px 6px !important;
    font-size: 12px !important;
    height: 22px !important;
    line-height: 20px !important;
    margin-top: 0px !important;
    cursor: pointer !important;
    flex-shrink: 0 !important;
    user-select: none !important;
    transition: opacity 0.15s ease, background-color 0.15s ease !important;
  }

  .warp-run-button:hover {
    opacity: 1 !important;
    background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31)) !important;
  }
`;

export class WarpInputBarManager extends BaseManager implements IWarpInputBarManager {
  private readonly coordinator: IManagerCoordinator;
  private readonly terminalStates = new Map<string, TerminalInputBarState>();
  private static isStyleInjected = false;

  constructor(coordinator: IManagerCoordinator) {
    super('WarpInputBarManager', {
      enableLogging: true,
      enableValidation: true,
      enableErrorRecovery: true,
    });
    this.coordinator = coordinator;
  }

  /**
   * 初始化管理器，绑定当前已有终端并注入样式
   */
  protected override doInitialize(): void {
    this.injectStyles();

    const allInstances = this.coordinator.getAllTerminalInstances?.();
    if (allInstances) {
      for (const terminalId of allInstances.keys()) {
        this.attachTerminal(terminalId);
      }
    }
    this.logger('✅ Warp 底部固定输入框管理器初始化成功');
  }

  /**
   * 注入 Warp 输入框全局 CSS 样式（单例只注入一次）
   */
  private injectStyles(): void {
    if (WarpInputBarManager.isStyleInjected || typeof document === 'undefined') {
      return;
    }

    const existingStyle = document.getElementById('warp-input-bar-styles');
    if (existingStyle) {
      WarpInputBarManager.isStyleInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = 'warp-input-bar-styles';
    style.textContent = WARP_INPUT_BAR_CSS;

    document.head.appendChild(style);
    WarpInputBarManager.isStyleInjected = true;
  }

  /**
   * 为指定终端挂载底部固定输入栏
   */
  public attachTerminal(terminalId: string): void {
    if (this.terminalStates.has(terminalId)) {
      return;
    }

    this.injectStyles();

    const instance = this.coordinator.getTerminalInstance(terminalId);
    let container = instance?.container;
    if (!container && typeof document !== 'undefined') {
      container =
        (document.querySelector(`[data-terminal-id="${terminalId}"]`) as HTMLElement) ||
        this.coordinator.getAllTerminalContainers?.()?.get(terminalId);
    }

    if (!container) {
      this.logger(`⚠️ 未找到终端 ${terminalId} 的 DOM 容器，稍后重试`);
      return;
    }

    this.setupContainerLayout(container);

    const { barElement, cardElement, badgeElement, inputElement, runButton } =
      this.createDomElements(terminalId);

    cardElement.appendChild(badgeElement);
    cardElement.appendChild(inputElement);
    cardElement.appendChild(runButton);
    barElement.appendChild(cardElement);
    container.appendChild(barElement);

    // 监听输入栏或容器尺寸变化，防抖自动重适配并同步尺寸
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      let resizeTimer: number | null = null;
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer !== null) {
          window.clearTimeout(resizeTimer);
        }
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          this.refitAndSyncTerminal(terminalId);
        }, 50);
      });
      resizeObserver.observe(container);
    }

    const state: TerminalInputBarState = {
      barElement,
      inputElement,
      runButton,
      history: [],
      historyIndex: 0,
      disposables: [],
      resizeObserver,
    };

    this.bindEvents(terminalId, state, container);
    this.terminalStates.set(terminalId, state);

    // 挂载后立即执行一次尺寸重适配与 PTY 同步
    this.refitAndSyncTerminal(terminalId);

    // 双重自适应（Double-fit）：等待下一渲染帧与延时定时器，应对 CSS 动画或 DOM 布局未完成的情况
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        this.refitAndSyncTerminal(terminalId);
      });
    }
    setTimeout(() => {
      this.refitAndSyncTerminal(terminalId);
    }, 50);

    inputElement.focus();
    this.logger(`✅ 终端 ${terminalId} 底部 Warp 输入框已挂载并激活`);
  }

  /**
   * 调整终端容器与展示区样式以配合输入栏
   */
  private setupContainerLayout(container: HTMLElement): void {
    const terminalContent = container.querySelector('.terminal-content') as HTMLElement | null;
    if (terminalContent) {
      terminalContent.style.setProperty('height', 'auto', 'important');
      terminalContent.style.setProperty('flex', '1 1 0%', 'important');
      terminalContent.style.setProperty('min-height', '0', 'important');
    }
    container.style.setProperty('display', 'flex', 'important');
    container.style.setProperty('flex-direction', 'column', 'important');
  }

  /**
   * 创建 Warp 输入框相关 DOM 节点
   */
  private createDomElements(terminalId: string): {
    barElement: HTMLElement;
    cardElement: HTMLElement;
    badgeElement: HTMLElement;
    inputElement: HTMLTextAreaElement;
    runButton: HTMLButtonElement;
  } {
    const barElement = document.createElement('div');
    barElement.className = 'warp-input-bar';
    barElement.setAttribute('data-terminal-id', terminalId);

    const cardElement = document.createElement('div');
    cardElement.className = 'warp-input-card';

    const badgeElement = document.createElement('span');
    badgeElement.className = 'warp-prompt-badge';
    badgeElement.textContent = '❯';

    const inputElement = document.createElement('textarea');
    inputElement.className = 'warp-input-field';
    inputElement.rows = 1;
    inputElement.placeholder = '输入命令并回车执行...';
    inputElement.setAttribute('autocomplete', 'off');
    inputElement.setAttribute('autocorrect', 'off');
    inputElement.setAttribute('autocapitalize', 'off');
    inputElement.setAttribute('spellcheck', 'false');

    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'warp-run-button';
    runButton.title = '执行命令 (Enter, Shift+Enter 换行)';
    runButton.textContent = '⏎';

    return { barElement, cardElement, badgeElement, inputElement, runButton };
  }

  /**
   * 自适应调整输入框高度以适应多行内容，并适时触发终端视口重适配
   */
  private adjustInputHeight(inputElement: HTMLTextAreaElement, terminalId?: string): void {
    inputElement.style.height = 'auto';
    const scrollHeight = inputElement.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, 20), 160);
    inputElement.style.height = `${targetHeight}px`;
    inputElement.style.overflowY = scrollHeight > 160 ? 'auto' : 'hidden';

    if (terminalId) {
      this.refitAndSyncTerminal(terminalId);
    }
  }

  /**
   * 绑定输入栏交互与键盘事件
   */
  private bindEvents(
    terminalId: string,
    state: TerminalInputBarState,
    container: HTMLElement
  ): void {
    const { barElement, inputElement, runButton, disposables } = state;

    const execute = (): void => {
      const command = inputElement.value;
      if (command.trim().length > 0) {
        state.history.push(command);
        state.historyIndex = state.history.length;
      }

      // 1. 刷新输出缓冲区，确保屏幕与当前输出流立即对齐，消除可能残留的渲染延迟
      try {
        const perfManager = this.coordinator.getManagers?.().performance;
        perfManager?.flushOutputBuffer?.();
      } catch {
        // 容错处理
      }

      // 2. 立即将视口滚动至最新行，确保用户视线紧跟即将到来的输出
      const instance = this.coordinator.getTerminalInstance(terminalId);
      if (instance?.terminal && typeof instance.terminal.scrollToBottom === 'function') {
        try {
          instance.terminal.scrollToBottom();
        } catch {
          // 容错处理
        }
      }

      // 3. 派发执行命令（附带 \r）
      this.dispatchCommand(terminalId, command);

      // 4. 清空输入框并重置自适应高度，保持聚焦
      inputElement.value = '';
      this.adjustInputHeight(inputElement, terminalId);
      inputElement.focus();

      // 5. 在随后的时间片触发延迟滚动，以承接 PTY 回显与命令输出
      setTimeout(() => {
        if (instance?.terminal && typeof instance.terminal.scrollToBottom === 'function') {
          try {
            instance.terminal.scrollToBottom();
          } catch {}
        }
      }, 20);
      setTimeout(() => {
        if (instance?.terminal && typeof instance.terminal.scrollToBottom === 'function') {
          try {
            instance.terminal.scrollToBottom();
          } catch {}
        }
      }, 80);
    };

    const keydownHandler = (event: KeyboardEvent): void => {
      this.handleKeydown(event, state, terminalId, execute);
    };

    inputElement.addEventListener('keydown', keydownHandler);
    disposables.push(() => inputElement.removeEventListener('keydown', keydownHandler));

    // 监听输入变化，实时自适应调整高度
    const inputChangeHandler = (): void => {
      this.adjustInputHeight(inputElement, terminalId);
    };
    inputElement.addEventListener('input', inputChangeHandler);
    disposables.push(() => inputElement.removeEventListener('input', inputChangeHandler));

    // 聚焦输入框时同步激活当前终端（仅当当前激活终端不一致时才切换，彻底杜绝重复激活导致的 IPC 消息风暴）
    const inputFocusHandler = (): void => {
      if (this.coordinator.getActiveTerminalId?.() !== terminalId) {
        this.coordinator.setActiveTerminalId?.(terminalId);
      }
    };
    inputElement.addEventListener('focus', inputFocusHandler);
    disposables.push(() => inputElement.removeEventListener('focus', inputFocusHandler));

    // 阻止底栏内部点击/按下事件冒泡到 container，避免触发上层容器的夺焦行为
    const stopBubble = (event: Event): void => {
      event.stopPropagation();
    };
    barElement.addEventListener('pointerdown', stopBubble);
    barElement.addEventListener('mousedown', stopBubble);
    disposables.push(() => barElement.removeEventListener('pointerdown', stopBubble));
    disposables.push(() => barElement.removeEventListener('mousedown', stopBubble));

    // 点击底栏空白处时聚焦输入框
    const barClickHandler = (event: MouseEvent): void => {
      event.stopPropagation();
      if (this.coordinator.getActiveTerminalId?.() !== terminalId) {
        this.coordinator.setActiveTerminalId?.(terminalId);
      }
      inputElement.focus();
    };
    barElement.addEventListener('click', barClickHandler);
    disposables.push(() => barElement.removeEventListener('click', barClickHandler));

    const runClickHandler = (event: MouseEvent): void => {
      event.stopPropagation();
      execute();
    };
    runButton.addEventListener('click', runClickHandler);
    disposables.push(() => runButton.removeEventListener('click', runClickHandler));

    const containerClickHandler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.terminal-header') || target?.closest('.warp-input-bar')) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.toString().length === 0) {
        inputElement.focus();
      }
    };
    container.addEventListener('click', containerClickHandler);
    disposables.push(() => container.removeEventListener('click', containerClickHandler));

    // 焦点重定向卫士：若 xterm 原生隐藏文本框意外获得焦点，安全切回底部 Warp 输入框（防重入）
    let isRedirecting = false;
    const setupTextareaFocusGuard = (): void => {
      const xtermTextarea = container.querySelector(
        '.xterm-helper-textarea'
      ) as HTMLTextAreaElement | null;
      if (xtermTextarea) {
        const redirectFocus = (): void => {
          if (isRedirecting) {
            return;
          }
          isRedirecting = true;
          try {
            inputElement.focus();
          } finally {
            isRedirecting = false;
          }
        };
        xtermTextarea.addEventListener('focus', redirectFocus);
        disposables.push(() => xtermTextarea.removeEventListener('focus', redirectFocus));
      }
    };
    setupTextareaFocusGuard();
    setTimeout(setupTextareaFocusGuard, 100);
  }

  /**
   * 键盘事件统一派发处理
   */
  private handleKeydown(
    event: KeyboardEvent,
    state: TerminalInputBarState,
    terminalId: string,
    execute: () => void
  ): void {
    // 1. Shift+Enter 或 Alt+Enter：在输入框当前光标处插入换行符，阻止默认行为与事件冒泡，自适应高度
    if (
      event.key === 'Enter' &&
      (event.shiftKey || event.altKey) &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.insertNewlineAtCursor(state.inputElement);
      this.adjustInputHeight(state.inputElement, terminalId);
      return;
    }

    // 2. 单独 Enter 键（非合成态、无换行修饰键）：阻止默认行为与冒泡，提交执行命令
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      event.stopPropagation();
      execute();
      return;
    }

    if (this.handleHistoryNavigation(event, state, terminalId)) {
      return;
    }

    this.handleSpecialShortcuts(event, state, terminalId);
  }

  /**
   * 处理上下箭头键的历史命令切换
   */
  private handleHistoryNavigation(
    event: KeyboardEvent,
    state: TerminalInputBarState,
    terminalId: string
  ): boolean {
    const { inputElement, history } = state;

    if (event.key === 'ArrowUp') {
      // 多行文本时光标不在首行，应当在文本内上下行移动光标，不触发历史回溯
      const textBeforeCursor = inputElement.value.slice(0, inputElement.selectionStart ?? 0);
      if (textBeforeCursor.includes('\n')) {
        return false;
      }

      if (history.length > 0 && state.historyIndex > 0) {
        event.preventDefault();
        state.historyIndex--;
        inputElement.value = history[state.historyIndex] || '';
        this.adjustInputHeight(inputElement, terminalId);
        inputElement.setSelectionRange(inputElement.value.length, inputElement.value.length);
        return true;
      }
      return false;
    }

    if (event.key === 'ArrowDown') {
      // 多行文本时光标不在末行，应当在文本内上下行移动光标，不触发历史回溯
      const textAfterCursor = inputElement.value.slice(inputElement.selectionEnd ?? 0);
      if (textAfterCursor.includes('\n')) {
        return false;
      }

      if (state.historyIndex < history.length - 1) {
        event.preventDefault();
        state.historyIndex++;
        inputElement.value = history[state.historyIndex] || '';
        this.adjustInputHeight(inputElement, terminalId);
        inputElement.setSelectionRange(inputElement.value.length, inputElement.value.length);
        return true;
      } else if (state.historyIndex === history.length - 1) {
        event.preventDefault();
        state.historyIndex = history.length;
        inputElement.value = '';
        this.adjustInputHeight(inputElement, terminalId);
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * 处理快捷键 (Ctrl+C, Ctrl+L)
   */
  private handleSpecialShortcuts(
    event: KeyboardEvent,
    state: TerminalInputBarState,
    terminalId: string
  ): void {
    const { inputElement } = state;

    if (
      event.ctrlKey &&
      (event.key === 'c' || event.key === 'C') &&
      inputElement.selectionStart === inputElement.selectionEnd
    ) {
      event.preventDefault();
      this.sendTerminalSignal(terminalId, '\x03');
      inputElement.value = '';
      return;
    }

    if (event.ctrlKey && event.key === 'l') {
      event.preventDefault();
      this.sendTerminalSignal(terminalId, '\x0c');
    }
  }

  /**
   * 在多行输入框当前光标位置插入换行符并平滑移动光标
   * 优先使用 document.execCommand 保留浏览器撤销/重做栈，环境不支持时降级至精确截串拼接
   */
  private insertNewlineAtCursor(inputElement: HTMLTextAreaElement): void {
    const start = inputElement.selectionStart ?? inputElement.value.length;
    const end = inputElement.selectionEnd ?? start;
    const originalValue = inputElement.value;

    let inserted = false;
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
      try {
        inserted = document.execCommand('insertText', false, '\n');
      } catch {
        inserted = false;
      }
    }

    if (!inserted) {
      inputElement.value = originalValue.substring(0, start) + '\n' + originalValue.substring(end);
      inputElement.selectionStart = inputElement.selectionEnd = start + 1;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /**
   * 发送终端控制信号或按键序列
   */
  private sendTerminalSignal(terminalId: string, signal: string): void {
    const messageManager = this.coordinator.getMessageManager?.();
    if (messageManager && typeof messageManager.sendInput === 'function') {
      messageManager.sendInput(signal, terminalId);
    } else {
      this.coordinator.postMessageToExtension({
        command: 'input',
        terminalId,
        data: signal,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 派发执行命令（统一将多行换行符映射为终端标准 \r，支持多行命令逐行提交执行）
   */
  private dispatchCommand(terminalId: string, command: string): void {
    const normalizedCommand = command.replace(/\r?\n/g, '\r');
    this.sendTerminalSignal(terminalId, normalizedCommand + '\r');
  }

  /**
   * 解绑并销毁指定终端的底部输入框
   */
  public detachTerminal(terminalId: string): void {
    const state = this.terminalStates.get(terminalId);
    if (!state) {
      return;
    }

    if (state.resizeObserver) {
      try {
        state.resizeObserver.disconnect();
      } catch {
        // 忽略清理异常
      }
      state.resizeObserver = null;
    }

    for (const cleanup of state.disposables) {
      try {
        cleanup();
      } catch {
        // 忽略清理异常
      }
    }

    state.barElement.remove();
    this.terminalStates.delete(terminalId);

    // 移除底栏后，终端展示区高度恢复，立即重新计算尺寸并通知后端 PTY 扩充行数
    this.refitAndSyncTerminal(terminalId);

    this.logger(`终端 ${terminalId} 底部 Warp 输入框已移除`);
  }

  /**
   * 重新适配终端视口尺寸并向后端 PTY 发送 resize 消息以对齐行数
   *
   * 核心原因与设计决策：
   * 底部固定输入卡片挂载后，.terminal-content 可用高度被缩减约 45px（2~3 行终端行）。
   * 若仅调用 fitAddon.fit() 而未向扩展端 node-pty 发送 resize 消息，后端进程仍会按照旧的行数（如 24 行）
   * 绘制提示符与命令输出，导致最新产生的输出行直接超出前端视口并被 xterm 外层容器裁切隐藏。
   * 用户会误以为“输出非常慢甚至不显示”，直到积累更多行把旧内容推上去才能看见。
   * 因此必须重置行内尺寸、执行双重自适应、刷新行缓存，并同步告知 PTY 最新的 cols 与 rows，同时滚动置底。
   */
  public refitAndSyncTerminal(terminalId: string): void {
    const instance = this.coordinator.getTerminalInstance(terminalId);
    if (!instance || !instance.terminal) {
      return;
    }

    try {
      const container = instance.container;
      if (container) {
        DOMUtils.resetXtermInlineStyles(container, true);
      }

      if (instance.fitAddon) {
        instance.fitAddon.fit();
      }

      const cols = instance.terminal.cols;
      const rows = instance.terminal.rows;

      if (typeof instance.terminal.refresh === 'function' && rows > 0) {
        instance.terminal.refresh(0, Math.max(rows - 1, 0));
      }

      // 遵循 VS Code 协议规范：向扩展端 node-pty 发送 resize 消息，同步终端行列数
      this.coordinator.postMessageToExtension({
        command: 'resize',
        terminalId,
        cols,
        rows,
      });

      // 尺寸变动后，若有 scrollToBottom 能力立即同步视口位置
      if (typeof instance.terminal.scrollToBottom === 'function') {
        instance.terminal.scrollToBottom();
      }
    } catch (error) {
      this.logger(`⚠️ 终端 ${terminalId} 尺寸重适配与同步异常:`, error);
    }
  }

  /**
   * 判断指定终端是否已挂载底部输入栏
   * @param terminalId 终端标识
   */
  public hasInputBar(terminalId: string): boolean {
    return this.terminalStates.has(terminalId);
  }

  /**
   * 聚焦指定终端的输入框
   */
  public focusInput(terminalId: string): void {
    const state = this.terminalStates.get(terminalId);
    if (state) {
      state.inputElement.focus();
    }
  }

  /**
   * 获取终端当前历史命令（便于测试与扩展）
   */
  public getHistory(terminalId: string): string[] {
    return this.terminalStates.get(terminalId)?.history || [];
  }

  /**
   * 获取指定终端输入 DOM 元素
   */
  public getInputElement(terminalId: string): HTMLTextAreaElement | undefined {
    return this.terminalStates.get(terminalId)?.inputElement;
  }

  /**
   * 释放所有终端输入栏
   */
  protected override doDispose(): void {
    for (const terminalId of Array.from(this.terminalStates.keys())) {
      this.detachTerminal(terminalId);
    }
    this.terminalStates.clear();
  }
}
