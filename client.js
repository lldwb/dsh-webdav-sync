/**
 * `dsh-webdav-sync` —— 浏览器半。
 *
 * 手写 bundle，形态与内置设置页一致：`window.__ModuleLoader__.load({ id, factory })`
 * 配一个惰性 CJS 工厂。DSH 的模块清单会根据本包的 `dsh.client` 声明发现它，并在
 * `/plugins/dsh-webdav-sync/client.js` 上提供它。
 *
 * 本页编辑的是 `webdav-sync` 设置命名空间，也就是 Host 半自己的 `Config`
 * （见 index.js）。只有当 Host 提供该命名空间（Loader 行存在）时页面才会挂载，
 * 因此没有装这个插件的 profile 看不到任何痕迹。
 *
 * 这里的 `require` 只解析两个说明符 —— `react/jsx-runtime` 与
 * `@deepseek-ai/dsh-client-ui-primitives` —— 二者都是 shell 自身模块表中的静态模块。
 * 也就是说本页不能直接 `require('react')`：所有本地状态（动作进行中、RPC 结果、
 * 状态轮询快照、凭据是否已配置）都放进 controller 的 snapshot store，由槽位注入的
 * `useWebdavSync` hook 推送重渲染。轮询 interval 与各类订阅都由 controller 的
 * `dispose()` 在插件卸载时统一清理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdav-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react_jsx_runtime = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region locales
    /** 英文文案。 */
    const en = {
      title: 'WebDAV cloud sync',
      description: 'Sync DeepSeek Harness configuration and plugins across devices over WebDAV, without sessions.',
      syncType: 'Sync method',
      syncTypeWebdav: 'WebDAV',
      provider: 'Provider',
      providerHint: 'Picking a provider fills in the matching WebDAV address template.',
      presetJianguoyun: 'Nutstore (Jianguoyun)',
      presetNextcloud: 'Nextcloud',
      presetSynology: 'Synology DSM',
      presetCustom: 'Custom',
      presetJianguoyunHint:
        'Create a third-party app password under Account info → Security options and use it as the password. Make sure the server address ends with /dav/.',
      presetNextcloudHint:
        'Replace USER with your Nextcloud user name, and make sure the address ends with remote.php/dav/files/.',
      presetSynologyHint:
        'Enable WebDAV under Control Panel → File Services → WebDAV. The port is usually 5005 (HTTP) or 5006 (HTTPS).',
      presetCustomHint: 'Enter the full WebDAV server address yourself, including scheme and path.',
      baseUrl: 'WebDAV server address',
      baseUrlHint: 'Include the scheme and path, for example https://dav.jianguoyun.com/dav/.',
      baseUrlPlaceholder: 'https://dav.jianguoyun.com/dav/',
      username: 'WebDAV account',
      usernameHint: 'The WebDAV user name; Nutstore usually uses the registered email.',
      usernamePlaceholder: 'name@example.com',
      password: 'WebDAV password',
      passwordHint: 'Stored in the credentials domain, never in the settings file. Nutstore needs a third-party app password.',
      passwordSet: 'Configured',
      passwordUnset: 'Not configured',
      remoteRoot: 'Remote root directory',
      remoteRootHint: 'Root directory that holds the synced data on the server. Defaults to dsh-sync.',
      remoteRootPlaceholder: 'dsh-sync',
      syncProfile: 'Sync profile name',
      syncProfileHint: 'Distinguishes several sync profiles. Defaults to default.',
      syncProfilePlaceholder: 'default',
      autoSync: 'Auto sync',
      autoSyncHint: 'Upload configuration changes to WebDAV automatically (debounced by about 1.5 seconds).',
      syncCredentials: 'Sync the credentials file',
      syncCredentialsHint:
        'On: .credentials.yaml (which holds API keys) is synced too. Off: only configuration and plugins are synced.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      save: 'Save configuration',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      lastSyncLabel: 'Last sync',
      neverSynced: 'never synced',
      statusLabel: 'Status',
      statusIdle: 'idle',
      statusBusy: 'syncing…',
      statusFailed: 'failed: ',
      remotePathLabel: 'Remote directory',
      localProfileLabel: 'Local profile',
      statusUnavailable: 'Sync status unavailable',
      passwordWarning: 'No WebDAV password is configured, so upload and download will fail.',
      test: 'Test connection',
      testing: 'Testing…',
      upload: 'Upload to cloud',
      uploading: 'Uploading…',
      download: 'Download from cloud',
      downloading: 'Downloading…',
      testSuccess: 'Connection succeeded',
      uploadSuccess: 'Upload finished',
      downloadSuccess: 'Download finished',
      downloadRestart: '; restart DSH to apply.',
      pluginWarnings: '; plugin warnings: ',
      downloadInstall:
        '; plugins were restored into the profile: run the command below, then restart DSH — ',
      downloadInstallTail: ' (this machine had no original plugin directory, so the packages now live in <profile>/plugins).',
      actionSuccess: 'Done.',
      actionFailed: 'The action failed.',
      saveBlocked: 'The form still has unsaved or invalid fields, so this action was cancelled.',
      unitFiles: 'files',
      unitPlugins: 'plugins',
      unitSeconds: 's',
      writtenLabel: 'written',
      backupLabel: 'backed up',
      summaryJoin: ': ',
      summarySeparator: ', '
    };

    /** 简体中文文案。 */
    const zh = {
      title: 'WebDAV 云同步',
      description: '通过 WebDAV 在多设备之间同步 DeepSeek Harness 的配置与插件，不包含会话。',
      syncType: '同步方式',
      syncTypeWebdav: 'WebDAV',
      provider: '服务商',
      providerHint: '选择服务商会自动填入对应的 WebDAV 地址模板。',
      presetJianguoyun: '坚果云',
      presetNextcloud: 'Nextcloud',
      presetSynology: '群晖 DSM',
      presetCustom: '自定义',
      presetJianguoyunHint:
        '坚果云请在「账户信息 → 安全选项」中生成「第三方应用密码」并作为密码使用；同时确认服务器地址以 /dav/ 结尾。',
      presetNextcloudHint: '把 USER 换成你的 Nextcloud 用户名，并确认地址以 remote.php/dav/files/ 结尾。',
      presetSynologyHint: '群晖在「控制面板 → 文件服务 → WebDAV」开启服务；端口通常是 5005（HTTP）或 5006（HTTPS）。',
      presetCustomHint: '手动填写完整的 WebDAV 服务器地址，要包含协议与路径。',
      baseUrl: 'WebDAV 服务器地址',
      baseUrlHint: '包含协议与路径，例如 https://dav.jianguoyun.com/dav/。',
      baseUrlPlaceholder: 'https://dav.jianguoyun.com/dav/',
      username: 'WebDAV 账户',
      usernameHint: 'WebDAV 用户名；坚果云通常使用注册邮箱。',
      usernamePlaceholder: 'name@example.com',
      password: 'WebDAV 密码',
      passwordHint: '密码保存在凭据域，不写入设置文件；坚果云请使用「第三方应用密码」。',
      passwordSet: '已配置',
      passwordUnset: '未配置',
      remoteRoot: '远程根目录',
      remoteRootHint: '远端存放同步数据的根目录，默认 dsh-sync。',
      remoteRootPlaceholder: 'dsh-sync',
      syncProfile: '同步配置名',
      syncProfileHint: '用不同名字区分多套同步配置，默认 default。',
      syncProfilePlaceholder: 'default',
      autoSync: '自动同步',
      autoSyncHint: '开启后配置文件变化会自动上传到 WebDAV（防抖约 1.5 秒）。',
      syncCredentials: '同步凭据文件',
      syncCredentialsHint: '开启时一并同步 .credentials.yaml（含 API 密钥）；关闭则只同步配置与插件。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      save: '保存配置',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      lastSyncLabel: '上次同步',
      neverSynced: '从未同步',
      statusLabel: '状态',
      statusIdle: '空闲',
      statusBusy: '同步中…',
      statusFailed: '失败：',
      remotePathLabel: '远端目录',
      localProfileLabel: '本地配置',
      statusUnavailable: '无法读取同步状态',
      passwordWarning: '尚未配置 WebDAV 密码，上传与下载会失败。',
      test: '测试连接',
      testing: '测试中…',
      upload: '上传到云端',
      uploading: '上传中…',
      download: '从云端下载',
      downloading: '下载中…',
      testSuccess: '连接成功',
      uploadSuccess: '上传完成',
      downloadSuccess: '下载完成',
      downloadRestart: '；重启 DSH 后生效。',
      pluginWarnings: '；插件写入警告：',
      downloadInstall: '；有插件被恢复到 profile 内目录，请先运行下面的命令再重启 DSH：',
      downloadInstallTail: '（本机没有这些插件的原目录，插件已放进 <profile>/plugins）。',
      actionSuccess: '操作完成。',
      actionFailed: '操作失败。',
      saveBlocked: '表单还有未保存或无效的字段，已取消本次操作。',
      unitFiles: '个文件',
      unitPlugins: '个插件',
      unitSeconds: '秒',
      writtenLabel: '已写入',
      backupLabel: '已备份',
      summaryJoin: '：',
      summarySeparator: '，'
    };
    // #endregion

    /** 本插件拥有的词典命名空间（仅代码内词典，用于设置页正文）。 */
    const NS = 'settings.webdavSync';

    /**
     * 本页面所编辑的 Host 设置命名空间。写死而不是导入：客户端包不能依赖 Host 包。
     * 它等于 Loader 行 id，也就是 Host 半的 `name` 导出。
     */
    const SETTINGS_NS = 'webdav-sync';

    /** Host 半注册的 RPC 通道（`ctx.connection.rpc.handle('/dsh-webdav-sync', ...)`）。 */
    const RPC_CHANNEL = '/dsh-webdav-sync';

    /** WebDAV 密码的凭据引用，与 Host 配置的默认 `passwordRef` 一致。 */
    const PASSWORD_REF = 'DSH_WEBDAV_SYNC_PASSWORD';

    /** 密码控件在表单模型里的暂存字段名（不是 Config 字段）。 */
    const PASSWORD_FIELD = 'password';

    /** 状态轮询间隔（毫秒）。 */
    const STATUS_POLL_MS = 2000;

    /** 保存回退路径：最长等待与轮询间隔（毫秒）。 */
    const SAVE_WAIT_MS = 5000;
    const SAVE_POLL_MS = 50;

    /** 主色：截图里的橙色按钮。 */
    const COLOR_PRIMARY = '#ff5a1f';

    /** 失败与成功的结果色。 */
    const COLOR_ERROR = '#d92d20';
    const COLOR_SUCCESS = '#12805c';

    /** 自定义字段行与内置字段行共用的分隔线。 */
    const SEPARATOR = '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))';

    /** 自定义字段行的容器样式（与内置字段的垂直布局一致）。 */
    const FIELD_BASE_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '12px 0'
    };

    /** 字段行标题行。 */
    const HEAD_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' };

    /** 字段标签。 */
    const LABEL_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 字段提示文字。 */
    const HINT_STYLE = {
      margin: 0,
      fontSize: '12px',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-tertiary, inherit)'
    };

    /** 控件行（开关等）。 */
    const CONTROL_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '12px' };

    /** 灰色圆角面板：把整组 WebDAV 字段包起来，贴近截图。 */
    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      margin: '8px 0 4px',
      padding: '2px 20px',
      background: 'rgba(128, 128, 128, 0.09)',
      borderRadius: '12px'
    };

    /** 状态区 / 动作区的外框样式。 */
    const SECTION_STYLE = { padding: '12px 0' };

    /** 信息行（状态区里的一「标签 + 值」）。 */
    const INFO_ROW_STYLE = { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: 1.6, minWidth: 0 };

    /** 动作按钮行的布局。 */
    const BUTTON_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' };

    /**
     * WebDAV 服务商预设。
     *
     * `baseUrl` 为空表示「自定义」：选中它只记录服务商名，保留用户当前的地址。
     */
    const PROVIDER_PRESETS = [
      {
        id: 'jianguoyun',
        labelKey: 'presetJianguoyun',
        hintKey: 'presetJianguoyunHint',
        baseUrl: 'https://dav.jianguoyun.com/dav/'
      },
      {
        id: 'nextcloud',
        labelKey: 'presetNextcloud',
        hintKey: 'presetNextcloudHint',
        baseUrl: 'https://your-nextcloud.example.com/remote.php/dav/files/USER/'
      },
      {
        id: 'synology',
        labelKey: 'presetSynology',
        hintKey: 'presetSynologyHint',
        baseUrl: 'https://your-nas.example.com:5006/'
      },
      {
        id: 'custom',
        labelKey: 'presetCustom',
        hintKey: 'presetCustomHint',
        baseUrl: ''
      }
    ];

    /**
     * {@link P.SettingsFormModel} 用的一种布尔字段类型。
     *
     * 内置的字段类型只有文本和数字；开关需要自己的类型，但契约很小 —— `format` 把
     * 存储值渲染成暂存文本，`parse` 把暂存文本变回一次写入。
     *
     * @param field - 配置字段名。
     * @returns 字段规格。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }

    /** 共享设置表单所渲染的标签。 */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving')
      };
    }

    /** 把 unix 秒格式化成 `yyyy/MM/dd HH:mm:ss`（本地时区）。 */
    function formatTimestamp(unixSeconds) {
      const date = new Date(unixSeconds * 1000);
      if (Number.isNaN(date.getTime())) return String(unixSeconds);
      const pad = (value) => String(value).padStart(2, '0');
      return (
        `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      );
    }

    /** 人类可读的字节数。 */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB'];
      let value = bytes / 1024;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value.toFixed(1)} ${units[index]}`;
    }

    /** 任意抛出值的展示文案。 */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error && typeof error.message === 'string') return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    /**
     * RPC 失败信封 → 展示文案。
     *
     * Host 的失败形状是 `{ ok: false, error: { code, message, details } }`；这里把
     * `message` 作为主体显示，`code` 存在时作为前缀帮助定位。
     */
    function describeRpcError(error) {
      const code = error && typeof error.code === 'string' ? error.code : '';
      const message = error && typeof error.message === 'string' ? error.message : '';
      if (message !== '' && code !== '') return `${code}：${message}`;
      if (message !== '') return message;
      if (code !== '') return code;
      return '';
    }

    /**
     * 动作返回的 warnings 列表。
     *
     * Host 的 download / upload 目前用 `warnings: string[]`；早期设计文档写的是
     * `pluginWarnings`。这里两者都认，避免字段名变化时静默丢失警告。
     *
     * @param value - RPC 成功返回的 value。
     * @returns 警告列表（一定为数组）。
     */
    function warningsOf(value) {
      if (!value) return [];
      if (Array.isArray(value.warnings)) return value.warnings;
      if (Array.isArray(value.pluginWarnings)) return value.pluginWarnings;
      return [];
    }

    /**
     * 动作返回的 warnings 数量后缀。
     *
     * @param t - 页面词典读取器。
     * @param value - RPC 成功返回的 value。
     * @returns 有警告时的文案后缀，否则为空串。
     */
    function warningsSuffix(t, value) {
      const warnings = warningsOf(value);
      if (warnings.length === 0) return '';
      return `${t('pluginWarnings')}${warnings.length}`;
    }

    /**
     * 把动作返回值压成一句摘要，例如「12 个文件，2 个插件，3.4 MB，0.8 秒」。
     *
     * 读取的键与 Host 的返回形状对齐：
     * - upload：`files`、`plugins:number`、`bytes`、`durationMs`
     * - download：`files`、`plugins:array`、`bytes`、`durationMs`、`written`、`backedUp`
     *
     * @param t - 页面词典读取器。
     * @param value - RPC 成功返回的 value。
     * @returns 摘要后缀；没有可展示字段时为空串。
     */
    function summarySuffix(t, value) {
      const parts = [];
      if (value && typeof value.files === 'number') parts.push(`${value.files} ${t('unitFiles')}`);
      if (value) {
        if (typeof value.plugins === 'number') parts.push(`${value.plugins} ${t('unitPlugins')}`);
        else if (Array.isArray(value.plugins)) parts.push(`${value.plugins.length} ${t('unitPlugins')}`);
      }
      if (value && typeof value.bytes === 'number') parts.push(formatBytes(value.bytes));
      if (value && typeof value.durationMs === 'number') parts.push(`${(value.durationMs / 1000).toFixed(1)} ${t('unitSeconds')}`);
      if (value && typeof value.written === 'number') parts.push(`${t('writtenLabel')} ${value.written}`);
      if (value && typeof value.backedUp === 'number') parts.push(`${t('backupLabel')} ${value.backedUp}`);
      if (parts.length === 0) return '';
      return `${t('summaryJoin')}${parts.join(t('summarySeparator'))}`;
    }

    /** 下拉框样式：模仿内置字段的输入框。 */
    function selectStyle(disabled) {
      return {
        width: '100%',
        height: '34px',
        padding: '0 12px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
    }

    /** 按钮样式：`primary` 为橙色主按钮，其余为描边次要按钮。 */
    function buttonStyle(variant, disabled) {
      const base = {
        height: '34px',
        padding: '0 18px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
      if (variant === 'primary') {
        return { ...base, border: 'none', background: COLOR_PRIMARY, color: '#ffffff' };
      }
      return {
        ...base,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)'
      };
    }

    /**
     * 一行「标签 + 控件」，垂直布局与内置字段一致。
     *
     * 内置字段之间的分隔线来自它们自己的相邻选择器；这里给自定义行显式加线，
     * 以便与内置字段混排时视觉连续。
     */
    function FieldRow(props) {
      const style = { ...FIELD_BASE_STYLE };
      if (props.separator === 'top') style.borderTop = SEPARATOR;
      if (props.separator === 'bottom') style.borderBottom = SEPARATOR;
      return react_jsx_runtime.jsxs('div', {
        style,
        children: [
          react_jsx_runtime.jsx('div', {
            style: HEAD_STYLE,
            children: react_jsx_runtime.jsx('label', {
              htmlFor: props.id,
              style: LABEL_STYLE,
              children: props.label
            })
          }),
          react_jsx_runtime.jsx('div', { style: CONTROL_ROW_STYLE, children: props.control }),
          props.hint ? react_jsx_runtime.jsx('p', { style: HINT_STYLE, children: props.hint }) : null
        ]
      });
    }

    /** 原生下拉行。 */
    function SelectRow(props) {
      return react_jsx_runtime.jsx(FieldRow, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        separator: props.separator,
        control: react_jsx_runtime.jsx('select', {
          id: props.id,
          style: selectStyle(props.disabled),
          value: props.value,
          disabled: props.disabled,
          onChange: (event) => {
            props.onChange(event.target.value);
          },
          children: props.options.map((option) =>
            react_jsx_runtime.jsx('option', { value: option.value, children: option.label }, option.value)
          )
        })
      });
    }

    /**
     * 一个开关行。内置表单没有布尔字段组件，因此这里围绕导出的 `Switch` 原语渲染
     * 与文本字段相同的形态 —— 标签、控件、提示。
     */
    function ToggleRow(props) {
      return react_jsx_runtime.jsx(FieldRow, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        separator: props.separator,
        control: react_jsx_runtime.jsx(P.Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: (next) => {
            props.onEdit(next === true);
          }
        })
      });
    }

    /** 状态区里的一行信息。 */
    function InfoRow(props) {
      return react_jsx_runtime.jsxs('div', {
        style: INFO_ROW_STYLE,
        children: [
          react_jsx_runtime.jsxs('span', {
            style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, inherit)' },
            children: [props.label, props.separator]
          }),
          react_jsx_runtime.jsx('span', {
            style: {
              minWidth: 0,
              wordBreak: 'break-all',
              color: props.tone === 'error' ? COLOR_ERROR : 'var(--dsw-alias-label-secondary, inherit)'
            },
            children: props.value
          })
        ]
      });
    }

    /**
     * 状态区：上次同步时间、当前状态、远端目录、本地配置，以及密码未配置的警示。
     *
     * 数据来自每 2 秒一次的 `status` RPC；Host 还没回答或不可达时显示不可用文案。
     */
    function StatusSection(props) {
      const { t, state } = props;
      const status = state.status;
      const statusError = state.statusError;
      const serverState = status && status.state ? status.state : undefined;
      const lastSyncAt = serverState && typeof serverState.lastSyncAt === 'number' ? serverState.lastSyncAt : 0;

      let statusText;
      if (status === null && statusError !== '') {
        statusText = `${t('statusUnavailable')}${t('summaryJoin')}${statusError}`;
      } else if ((status && status.busy === true) || state.action !== null) {
        statusText = t('statusBusy');
      } else if (serverState && typeof serverState.lastError === 'string' && serverState.lastError !== '') {
        statusText = `${t('statusFailed')}${serverState.lastError}`;
      } else {
        statusText = t('statusIdle');
      }

      const remotePath =
        status && typeof status.remotePath === 'string' && status.remotePath !== '' ? status.remotePath : '—';
      const profileName =
        status && status.platform && typeof status.platform.profileName === 'string' && status.platform.profileName !== ''
          ? status.platform.profileName
          : '—';

      return react_jsx_runtime.jsxs('div', {
        style: { ...SECTION_STYLE, borderTop: SEPARATOR, display: 'flex', flexDirection: 'column', gap: '2px' },
        children: [
          react_jsx_runtime.jsx(InfoRow, {
            label: t('lastSyncLabel'),
            value: lastSyncAt > 0 ? formatTimestamp(lastSyncAt) : t('neverSynced')
          }),
          react_jsx_runtime.jsx(InfoRow, {
            label: t('statusLabel'),
            value: statusText,
            tone:
              status !== null && serverState && typeof serverState.lastError === 'string' && serverState.lastError !== ''
                ? 'error'
                : undefined
          }),
          react_jsx_runtime.jsx(InfoRow, { label: t('remotePathLabel'), value: remotePath }),
          react_jsx_runtime.jsx(InfoRow, { label: t('localProfileLabel'), value: profileName }),
          state.passwordConfigured
            ? null
            : react_jsx_runtime.jsx('p', {
                style: { margin: '6px 0 0', fontSize: '12px', lineHeight: 1.5, color: COLOR_ERROR },
                role: 'status',
                children: t('passwordWarning')
              })
        ]
      });
    }

    /**
     * 动作按钮区：测试连接一行，上传 / 下载一行。
     *
     * 保存按钮由 `SettingsForm` 自己渲染（footer），其标题也来自同一份词典的
     * `save` 词条，所以这里不再重复一个「保存配置」按钮。
     */
    function ActionSection(props) {
      const { t, state, onTest, onUpload, onDownload } = props;
      const disabled = !state.writable || state.saving || state.action !== null;
      const message = state.message;

      return react_jsx_runtime.jsxs('div', {
        style: { ...SECTION_STYLE, borderTop: SEPARATOR, display: 'flex', flexDirection: 'column', gap: '10px' },
        children: [
          react_jsx_runtime.jsx('div', {
            style: BUTTON_ROW_STYLE,
            children: react_jsx_runtime.jsx('button', {
              type: 'button',
              style: buttonStyle('secondary', disabled),
              disabled,
              onClick: onTest,
              children: state.action === 'test' ? t('testing') : t('test')
            })
          }),
          react_jsx_runtime.jsxs('div', {
            style: BUTTON_ROW_STYLE,
            children: [
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('primary', disabled),
                disabled,
                onClick: onUpload,
                children: state.action === 'upload' ? t('uploading') : t('upload')
              }),
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('secondary', disabled),
                disabled,
                onClick: onDownload,
                children: state.action === 'download' ? t('downloading') : t('download')
              })
            ]
          }),
          message
            ? react_jsx_runtime.jsx('p', {
                style: {
                  margin: 0,
                  fontSize: '12px',
                  lineHeight: 1.5,
                  color: message.tone === 'error' ? COLOR_ERROR : COLOR_SUCCESS
                },
                role: 'status',
                children: message.text
              })
            : null
        ]
      });
    }

    /**
     * 插件页里的 WebDAV 同步卡片。
     *
     * `props.view === 'summary'` 时插件列表只要一句话说明；详情视图渲染整张表单。
     * 组件本身不持有 hooks 之外的本地状态：动作进度、RPC 结果与轮询快照全部来自
     * controller 注入的 `useWebdavSync` store。
     */
    function WebdavSyncCard(props) {
      const { t } = props;
      const state = props.useWebdavSync((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const disabled = !state.writable || state.saving || state.action !== null;
      const preset =
        PROVIDER_PRESETS.find((item) => item.id === state.providerPreset.text) ??
        PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
      const presetOptions = PROVIDER_PRESETS.map((item) => ({ value: item.id, label: t(item.labelKey) }));
      const knownPreset = PROVIDER_PRESETS.some((item) => item.id === state.providerPreset.text);

      return react_jsx_runtime.jsx(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: react_jsx_runtime.jsxs('div', {
          style: PANEL_STYLE,
          children: [
            // 「同步方式」：当前只有 WebDAV，保留一个禁用下拉以贴近参考页面的信息结构。
            react_jsx_runtime.jsx(
              SelectRow,
              {
                id: 'webdav-sync-method',
                label: t('syncType'),
                disabled: true,
                value: 'webdav',
                options: [{ value: 'webdav', label: t('syncTypeWebdav') }],
                onChange: () => {}
              },
              'method'
            ),
            // 「服务商」：选中预设时自动填入对应地址模板；自定义保留用户当前值。
            react_jsx_runtime.jsx(
              SelectRow,
              {
                id: 'webdav-sync-provider',
                label: t('provider'),
                separator: 'bottom',
                hint: t(preset.hintKey),
                disabled,
                value: knownPreset ? state.providerPreset.text : 'custom',
                options: presetOptions,
                onChange: (value) => {
                  props.edit('providerPreset', value);
                  const chosen = PROVIDER_PRESETS.find((item) => item.id === value);
                  if (chosen !== undefined && chosen.baseUrl !== '') props.edit('baseUrl', chosen.baseUrl);
                }
              },
              'provider'
            ),
            react_jsx_runtime.jsx(
              P.SettingsValueField,
              {
                id: 'webdav-sync-base-url',
                label: t('baseUrl'),
                hint: t('baseUrlHint'),
                placeholder: t('baseUrlPlaceholder'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t('invalidNumber'),
                disabled: !state.writable || state.saving,
                ...state.baseUrl,
                onEdit: (text) => {
                  props.edit('baseUrl', text);
                },
                onReset: () => {
                  props.resetField('baseUrl');
                }
              },
              'baseUrl'
            ),
            react_jsx_runtime.jsx(
              P.SettingsValueField,
              {
                id: 'webdav-sync-username',
                label: t('username'),
                hint: t('usernameHint'),
                placeholder: t('usernamePlaceholder'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t('invalidNumber'),
                disabled: !state.writable || state.saving,
                ...state.username,
                onEdit: (text) => {
                  props.edit('username', text);
                },
                onReset: () => {
                  props.resetField('username');
                }
              },
              'username'
            ),
            react_jsx_runtime.jsx(
              P.SettingsSecretField,
              {
                id: 'webdav-sync-password',
                label: t('password'),
                hint: t('passwordHint'),
                disabled: !state.passwordWritable || state.saving,
                text: state.password.text,
                configured: state.passwordConfigured,
                stateLabel: state.passwordConfigured ? t('passwordSet') : t('passwordUnset'),
                onEdit: (text) => {
                  props.edit(PASSWORD_FIELD, text);
                }
              },
              'password'
            ),
            react_jsx_runtime.jsx(
              P.SettingsValueField,
              {
                id: 'webdav-sync-remote-root',
                label: t('remoteRoot'),
                hint: t('remoteRootHint'),
                placeholder: t('remoteRootPlaceholder'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t('invalidNumber'),
                disabled: !state.writable || state.saving,
                ...state.remoteRoot,
                onEdit: (text) => {
                  props.edit('remoteRoot', text);
                },
                onReset: () => {
                  props.resetField('remoteRoot');
                }
              },
              'remoteRoot'
            ),
            react_jsx_runtime.jsx(
              P.SettingsValueField,
              {
                id: 'webdav-sync-sync-profile',
                label: t('syncProfile'),
                hint: t('syncProfileHint'),
                placeholder: t('syncProfilePlaceholder'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t('invalidNumber'),
                disabled: !state.writable || state.saving,
                ...state.syncProfile,
                onEdit: (text) => {
                  props.edit('syncProfile', text);
                },
                onReset: () => {
                  props.resetField('syncProfile');
                }
              },
              'syncProfile'
            ),
            react_jsx_runtime.jsx(
              ToggleRow,
              {
                id: 'webdav-sync-auto-sync',
                label: t('autoSync'),
                hint: t('autoSyncHint'),
                separator: 'top',
                checked: state.autoSync.text !== 'false',
                disabled: !state.writable || state.saving,
                onEdit: (next) => {
                  props.edit('autoSync', next ? 'true' : 'false');
                }
              },
              'autoSync'
            ),
            react_jsx_runtime.jsx(
              ToggleRow,
              {
                id: 'webdav-sync-sync-credentials',
                label: t('syncCredentials'),
                hint: t('syncCredentialsHint'),
                separator: 'top',
                checked: state.syncCredentials.text !== 'false',
                disabled: !state.writable || state.saving,
                onEdit: (next) => {
                  props.edit('syncCredentials', next ? 'true' : 'false');
                }
              },
              'syncCredentials'
            ),
            react_jsx_runtime.jsx(StatusSection, { t, state }, 'status'),
            react_jsx_runtime.jsx(
              ActionSection,
              { t, state, onTest: props.test, onUpload: props.upload, onDownload: props.download },
              'actions'
            )
          ]
        })
      });
    }

    /**
     * 把设置作用域、凭据域与 Host RPC 桥接到页面上。
     *
     * 页面显示的全部内容由这里的一块 snapshot store 发布：表单字段的暂存状态来自
     * {@link P.SettingsFormModel}，其余（密码是否配置、动作进度、结果文案、status
     * 轮询快照）都是本类的字段。页面组件不持有 hooks，因此每 2 秒的轮询与各类订阅
     * 都由 {@link WebdavSyncCardController#dispose} 在插件卸载时清理。
     */
    class WebdavSyncCardController {
      /**
       * @param scope - `webdav-sync` 设置命名空间已绑定的设置作用域。
       * @param ctx - 页面插件的上下文（`remote.credentials` 与 `connection.rpc`）。
       * @param t - 本页词典读取器。
       */
      constructor(scope, ctx, t) {
        this.scope = scope;
        this.ctx = ctx;
        this.t = t;
        this.action = null;
        this.message = null;
        this.status = null;
        this.statusError = '';
        this.statusSerialized = '';
        this.statusPolling = false;
        this.disposed = false;
        this.credentials = { configured: false, writable: true };
        this.timer = undefined;

        this.form = new P.SettingsFormModel(
          scope,
          [
            P.settingsTextField('providerPreset'),
            P.settingsTextField('baseUrl'),
            P.settingsTextField('username'),
            P.settingsTextField('remoteRoot'),
            P.settingsTextField('syncProfile'),
            settingsBooleanField('autoSync'),
            settingsBooleanField('syncCredentials')
          ],
          [{ field: PASSWORD_FIELD, write: (text) => this.writePassword(text) }]
        );
        this.store = this.form.bind(() => this.projection());

        // 服务商预设只在「手动切换下拉」时写入地址；从已保存配置恢复表单时地址栏
        // 可能是空的（界面显示「坚果云」却没有地址，动作直接报未配置）。这里补偿
        // 一次，动作按钮保存后即生效（Host 侧另有同语义兜底）。
        this.applyPresetBaseUrlIfMissing();

        // 设置命名空间本身变化时（例如别处改了配置）重新确认凭据状态。
        this.unsubscribe = scope.subscribe(() => {
          this.readCredential();
        });

        // 挂载后立即取一次状态，之后每 2 秒刷新。
        this.timer = setInterval(() => {
          this.pollStatus();
        }, STATUS_POLL_MS);
        this.readCredential();
        this.pollStatus();
      }

      /**
       * 服务商预设补偿：预设已知但地址为空时，把预设地址填进表单暂存。
       *
       * 真实场景：用户在设置页选了「坚果云」并保存，之后重启 DSH；恢复出来的表单
       * 里 `providerPreset` 是 `jianguoyun` 而 `baseUrl` 是空（预设只在手动切换
       * 下拉那一刻写地址），于是「选了坚果云、账户密码都填了」仍报「尚未配置
       * WebDAV 服务器地址」。这里把预设地址补进暂存，动作按钮会先保存再执行。
       */
      applyPresetBaseUrlIfMissing() {
        try {
          const snapshot = this.scope.getSnapshot();
          const value = snapshot && snapshot.value ? snapshot.value : {};
          const savedBaseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
          if (savedBaseUrl !== '') return;
          const presetId = typeof value.providerPreset === 'string' ? value.providerPreset : '';
          const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
          if (preset === undefined || preset.baseUrl === '') return;
          const actions = this.form.actions();
          if (typeof actions.edit === 'function') actions.edit('baseUrl', preset.baseUrl);
        } catch {
          // 读取失败保持原样；Host 侧的 resolveBaseUrl 还会再兜底一次。
        }
      }

      /** 用表单当前的读取结果与页面自有状态构建页面快照。 */
      projection() {
        const shell = this.form.shell();
        const busy = this.action !== null;
        return {
          ...shell,
          // 动作进行中把「保存配置」也一并禁用：SettingsForm 的 footer 按钮
          // 在 invalid 为真时禁用，这里借用该条件覆盖内置按钮，不另外引用其 API。
          invalid: shell.invalid || busy,
          providerPreset: this.form.field('providerPreset'),
          baseUrl: this.form.field('baseUrl'),
          username: this.form.field('username'),
          remoteRoot: this.form.field('remoteRoot'),
          syncProfile: this.form.field('syncProfile'),
          autoSync: this.form.field('autoSync'),
          syncCredentials: this.form.field('syncCredentials'),
          password: this.form.field(PASSWORD_FIELD),
          passwordConfigured: this.credentials.configured,
          passwordWritable: this.credentials.writable,
          action: this.action,
          message: this.message,
          status: this.status,
          statusError: this.statusError
        };
      }

      /** 把当前快照推给页面。 */
      publish() {
        if (this.disposed) return;
        this.store.set(this.projection());
      }

      /**
       * 保存表单，返回是否已干净落盘。
       *
       * `SettingsFormModel` 的公开动作集中在 `form.actions()`；不同版本对顶层
       * `form.save()` 的暴露并不一致。这里先做特性检测：有顶层异步 `save()` 就用它
       * （能准确等到落盘），否则用 `actions().save()` 触发并轮询 `shell().saving`
       * 直到保存结束，避免运行时 `this.form.save is not a function`。
       *
       * @returns 保存后表单没有失败、没有无效字段、也没有遗留暂存。
       */
      async save() {
        const form = this.form;
        if (typeof form.save === 'function') {
          await form.save();
        } else {
          form.actions().save();
          const deadline = Date.now() + SAVE_WAIT_MS;
          while (form.shell().saving === true && Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, SAVE_POLL_MS);
            });
          }
        }
        const shell = form.shell();
        return !shell.failed && !shell.invalid && !shell.dirty;
      }

      /**
       * 向凭据域询问密码引用是否已配置。
       *
       * 字面值从不随响应下发，页面只能得知是否已配置；写入走凭据域。
       *
       * @returns 现在是否已配置。
       */
      async readCredential() {
        if (this.disposed) return this.credentials.configured;
        try {
          const response = await this.ctx.remote.credentials.describe([PASSWORD_REF]);
          if (!response || !response.ok || this.disposed) return this.credentials.configured;
          const view = response.value ? response.value[PASSWORD_REF] : undefined;
          const next = {
            configured: view ? view.configured === true : false,
            writable: view ? view.writable !== false : true
          };
          if (
            next.configured !== this.credentials.configured ||
            next.writable !== this.credentials.writable
          ) {
            this.credentials = next;
            this.publish();
          }
          return this.credentials.configured;
        } catch {
          // 凭据域暂不可用时保持「未配置」展示，等下一次通知再刷新。
          return this.credentials.configured;
        }
      }

      /** Host 报告密码引用发生变化后重新读取。 */
      refreshCredential(ref) {
        if (ref !== PASSWORD_REF) return;
        this.readCredential();
      }

      /** 写入暂存的密码，然后重新读取 Host 现在是否已持有密码。 */
      async writePassword(value) {
        await this.ctx.remote.credentials.set(PASSWORD_REF, value);
        await this.readCredential();
        return this.credentials.configured;
      }

      /**
       * 调用一个 RPC 端点，把 `{ ok, value | error }` 信封翻译成展示文案。
       *
       * 传输层错误会抛异常，调用方负责兜住。
       */
      async call(endpoint) {
        const result = await this.ctx.connection.rpc.call(RPC_CHANNEL, endpoint, {});
        if (result && result.ok === true) return result.value;
        const text = describeRpcError(result ? result.error : undefined);
        throw new Error(text !== '' ? text : this.t('actionFailed'));
      }

      /** 拉取一次同步状态，内容变化时才发布快照。 */
      async pollStatus() {
        if (this.disposed || this.statusPolling) return;
        this.statusPolling = true;
        try {
          const result = await this.ctx.connection.rpc.call(RPC_CHANNEL, 'status', {});
          if (this.disposed) return;
          if (result && result.ok === true) {
            const value = result.value === undefined ? null : result.value;
            this.status = value;
            this.statusError = '';
          } else {
            this.statusError = describeRpcError(result ? result.error : undefined) || this.t('statusUnavailable');
          }
        } catch (error) {
          if (this.disposed) return;
          this.status = null;
          this.statusError = messageOf(error);
        } finally {
          this.statusPolling = false;
          if (!this.disposed) {
            // 状态快照只在内容变化时刷新，避免每 2 秒无谓重渲染。
            const serialized = `${JSON.stringify(this.status)}|${this.statusError}`;
            if (serialized !== this.statusSerialized) {
              this.statusSerialized = serialized;
              this.publish();
            }
          }
        }
      }

      /** 把动作结果翻译成一句摘要文案。 */
      successText(endpoint, value) {
        if (endpoint === 'test') {
          const latency = value && typeof value.latencyMs === 'number' ? `${value.latencyMs} ms` : '';
          return latency === '' ? this.t('testSuccess') : `${this.t('testSuccess')}${this.t('summaryJoin')}${latency}`;
        }
        if (endpoint === 'upload') {
          return `${this.t('uploadSuccess')}${summarySuffix(this.t, value)}${warningsSuffix(this.t, value)}`;
        }
        if (endpoint === 'download') {
          // 跨机恢复：插件落到 <profile>/plugins，必须再跑一次依赖安装才能被 DSH
          // 解析（否则插件管理器显示「包不可用」）。把要跑的命令直接写在结果里。
          const install =
            value && value.requiresInstall === true
              ? `${this.t('downloadInstall')}${value.installHint || ''}${this.t('downloadInstallTail')}`
              : '';
          const restart = value && value.requiresRestart === true ? this.t('downloadRestart') : '';
          return `${this.t('downloadSuccess')}${summarySuffix(this.t, value)}${warningsSuffix(this.t, value)}${install}${restart}`;
        }
        return this.t('actionSuccess');
      }

      /**
       * 执行一个动作：先保存表单，保存不干净则取消；再调用对应 RPC。
       *
       * @param kind - 用于按钮文案的动作名（test / upload / download）。
       * @param endpoint - RPC 端点名。
       */
      async runAction(kind, endpoint) {
        if (this.action !== null || this.disposed) return;
        this.action = kind;
        this.message = null;
        this.publish();
        try {
          const saved = await this.save();
          if (!saved) {
            this.message = { tone: 'error', text: this.t('saveBlocked') };
            return;
          }
          const value = await this.call(endpoint);
          this.message = { tone: 'success', text: this.successText(endpoint, value) };
        } catch (error) {
          this.message = { tone: 'error', text: messageOf(error) || this.t('actionFailed') };
        } finally {
          this.action = null;
          this.publish();
          this.pollStatus();
        }
      }

      /** 构建页面槽位注册所注入的那张「面孔」。 */
      inject() {
        const actions = this.form.actions();
        return {
          hooks: { webdavSync: this.store },
          ...actions,
          // actions().save 丢弃了底层 Promise；动作按钮需要等真正落盘后再调 RPC。
          save: () => this.save(),
          test: () => this.runAction('test', 'test'),
          upload: () => this.runAction('upload', 'upload'),
          download: () => this.runAction('download', 'download')
        };
      }

      /** 释放轮询 interval 与全部订阅。 */
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer !== undefined) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /** 必需的服务（cordis fiber inject）。 */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms', 'connection'];

    /**
     * 在 Host 提供其命名空间期间挂载设置页。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-webdav-sync: 词典');

      const card = new WebdavSyncCardController(ctx.configForms.get(SETTINGS_NS), ctx, t);
      ctx.effect(
        () => () => {
          card.dispose();
        },
        'dsh-webdav-sync: 表单订阅与状态轮询'
      );
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            card.refreshCredential(ref);
          }),
        'dsh-webdav-sync: 凭据失效通知'
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'webdav-sync',
                  order: 42,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                WebdavSyncCard
              )
            )
          ),
        'dsh-webdav-sync: 设置页'
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
