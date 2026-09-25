# Gap 3: what the Dev Containers channels carry (verified against the installed code)

Step A1. Analysis only; no code was changed.

**Sources I checked:**
- Dev Containers 0.470.0: `dist/extension/extension.js`, `dist/common/remoteContainersServer.js`, `dist/common/remoteContainersCLI.js`, `package.json` and `package.nls.json`.
- VS Code 1.139.0 on the Mac (commit 2242ebbb…): `out/vs/workbench/api/node/extensionHostProcess.js` and `out/vs/workbench/workbench.desktop.main.js`.
- The matching VS Code server build, downloaded to `scratchpad/g3server/vscode-server-linux-arm64/`: `bin/helpers/browser.sh`, `bin/remote-cli/code`, `out/server-cli.js` and `out/server-main.js`.
- Dev Container CLI 0.89.0 (`scratchpad/cli/package`) and the CLI that ships inside Dev Containers (`dist/spec-node`).

**Checks I ran:**
- `scratchpad/g3-kv-check.mjs` takes class `kv`, `wl`/`ms` and `Coe` verbatim from extension.js and evaluates the settings reads.
- `scratchpad/g3-copycheck.py` runs the exact copy-test script from extension.js with sh and grep against sample files.

Numbers like `@586211` are character offsets in extension.js. Quotes are verbatim; `…` marks where I cut.

## Answers in short

1. **`REMOTE_CONTAINERS_IPC` carries exactly two request types:**
   - `git-credential-helper`: `get`, `store` and `erase` become `git credential fill`, `approve` and `reject`, run on the Mac.
   - `docker-credential-helper`: `get`, `list`, `store` and `erase`. The Mac's `~/.docker/config.json` is used, including base64 `auths` entries, and `docker-credential-<helper>` runs on the Mac.

   It carries nothing for the browser, `openExternal`, the `code` command or `gh`. The local handler checks no setting. Any process that can reach the socket can therefore read, store or delete the Mac's Git and Docker credentials.
2. **The browser does not use `REMOTE_CONTAINERS_IPC`:**
   - `$BROWSER` is the VS Code server's `bin/helpers/browser.sh`. It runs `server-cli.js --openExternal`, which posts to the server's command-line socket `VSCODE_IPC_HOOK_CLI`. The window then runs `_remoteCLI.openExternal`, which opens the URL on the Mac with tunnelling.
   - `vscode.env.openExternal` goes over the extension host's RPC connection (`MainThreadWindow.$openUri`).
   - "Open in Browser" runs entirely in the local window (`remote.tunnel.open` opens the tunnel's local URI).
   - Port forwarding uses the VS Code server connection (plus Dev Containers' own `docker exec` pipe for the server port).

   Neither VS Code nor any other installed extension reads `REMOTE_CONTAINERS_IPC`. So setting `REMOTE_CONTAINERS_IPC=''` keeps requirement (a).
3. **Settings read per container:** Dev Containers reads four of its settings per container, from the container's machine settings file `~/.vscode-server/data/Machine/settings.json`. It writes that file at the **first attach of a new container**, from `customizations.vscode[*].settings` of the merged configuration, which comes from the label `devcontainer.metadata`. The reads use different fallbacks:
   - `copyGitConfig` and `gitCredentialHelperConfigLocation`: the new key `||` the old key, then the user setting.
     - A `false` under `dev.containers.copyGitConfig` alone does **not** work; `remote.containers.copyGitConfig: false` does.
     - `"none"` works under either key.
   - `dockerCredentialHelper` and `githubCLILoginWithToken`: the new key only, then the user setting. `false` works; the old keys are ignored.
   - `dotfiles.*`: `remote.containers.dotfiles.*` or `dotfiles.*`, and only then the user setting. They cannot be switched off per container, because an empty value falls back to the user's value.
   - All other Dev Containers settings (19 more) are user settings only.
4. **copyGitConfig skip rule for `~/.gitconfig`:** Dev Containers skips the copy if and only if both hold:
   - the target exists (`[ -e '<home>/.gitconfig' ]`);
   - some line starts at column 0 with `[` and does not match `^\[(filter|safe)([[:blank:]]+|\])`.

   Otherwise it **appends** the Mac's file, provided the Mac has one, `git` exists in the container and the folder is writable. For `~/.config/git/config` (or `$XDG_CONFIG_HOME/git/config` in the remote environment), the copy is skipped whenever the target exists, even if it is empty.

**Recommendation:** add both of these to the override configuration and raise `CONTAINER_VERSION` to 3:
- `customizations.vscode.settings`, with **five flat keys**: `dev.containers.copyGitConfig: false`, `remote.containers.copyGitConfig: false`, `dev.containers.gitCredentialHelperConfigLocation: "none"`, `dev.containers.dockerCredentialHelper: false` and `dev.containers.githubCLILoginWithToken: false`.
- `remoteEnv.REMOTE_CONTAINERS_IPC = ''`.

The version bump matters because the settings reach Dev Containers only through the container's label, at its first attach.

Keep the `~/.gitconfig` guard and the Git, Docker and GPG variables as a second layer. Document the part that stays: the socket file and the helper script in `/tmp` still answer any process that looks for them. Details, tests, doc corrections and rejected alternatives follow in section 5.

## 1. What the `REMOTE_CONTAINERS_IPC` socket carries

At attach, the helper launch (`sS`, @525476) creates the socket, the server script and the client script. The Docker credential helper and the `gh` login are gated by per-container settings:
```js
((n==null?void 0:n.getNewConfiguration("githubCLILoginWithToken"))??e.isGitHubCLILoginWithTokenEnabled)&&await rre(t,u,i);let k=yr.posix.join(((G=t.env)==null?void 0:G.TMPDIR)||"/tmp",`vscode-remote-containers-ipc-${f}.sock`),I=yr.posix.join(((V=t.env)==null?void 0:V.TMPDIR)||"/tmp",`vscode-remote-containers-server-${f}.js`),O=yr.posix.join(((X=t.env)==null?void 0:X.TMPDIR)||"/tmp",`vscode-remote-containers-${f}.js`),A=((n==null?void 0:n.getNewConfiguration("dockerCredentialHelper"))??e.isDockerCredentialHelperEnabled)&&a&&await ZB(s,Gne)?yr.posix.join("/usr/local/bin",`docker-credential-${nk}${f}`):void 0,S=u.find(de=>de.type==="local"),D=QB(e,t,"Container",void 0,!1,!1,I,O,A,d,k,S),…
return …{remoteContainersCLI:O,remoteEnv:{REMOTE_CONTAINERS_IPC:k,...p?{SSH_AUTH_SOCK:p}:void 0,...E?{DISPLAY:E}:void 0,...v?{REMOTE_CONTAINERS_DISPLAY_SOCK:v}:void 0},…}
```
`nk="dev-containers-"` (@520742), so the Docker helper is `/usr/local/bin/docker-credential-dev-containers-<uuid>`.

The server gets the socket path on its own command line (`Jne`, @531367), not from `remoteEnv`. It runs again, with the same path, at every reconnect:
```js
p=`set -e ; echo -n ${ci} >&2 ; ${s?`rm -f '${s}' ; `:""}REMOTE_CONTAINERS_SOCKETS='${JSON.stringify(u)}' REMOTE_CONTAINERS_IPC='${s||""}' '${r}' '${o}' ; exit
```
Inside the container (`remoteContainersServer.js`), every HTTP body on the socket goes to the local `rpc` method:
```js
if(process.env.REMOTE_CONTAINERS_IPC){let e;kn.push(new Promise(t=>e=t)),xn.createServer((t,r)=>{let n=[];t.on("data",o=>n.push(o)),t.on("end",()=>{Z.rpc(Buffer.concat(n).toString(),(o,i)=>{…})})}).listen(process.env.REMOTE_CONTAINERS_IPC,e)}
```
The other forwarded sockets (SSH agent, X11, GPG agent, keyboxd) are separate paths from `REMOTE_CONTAINERS_SOCKETS` (`var En=JSON.parse(process.env.REMOTE_CONTAINERS_SOCKETS)` → one `createServer` per path). They do not use the IPC socket.

The local `rpc` handler (@532928) handles only two request types and checks no setting:
```js
rpc:async(S,D)=>{try{let{args:L,stdin:P}=JSON.parse(S);if(L[0]==="git-credential-helper"){let R=await kH(a,c,k.git,L,P);k.git=R.preferLocalCLIHost,D(void 0,JSON.stringify(R.result))}else if(L[0]==="docker-credential-helper"){let R=await VH(a,c,k.docker,L,P,l);k.docker=R.preferLocalCLIHost,D(void 0,JSON.stringify(R.result))}}catch(L){console.error(L),D(L)}},connected:S=>{S()},ready:S=>{E=!0,I(),S()}
```
Any other request type is never answered.

Git requests (`kH` @511364) run `git credential` on the Mac:
```js
let i=r[1],s={get:"fill",store:"approve",erase:"reject"}[i];…
async function IH({exec:e},t,n){try{let{stdout:r,stderr:o}=await ce({exec:e,cmd:"git",args:["credential",t],env:{GIT_TERMINAL_PROMPT:"0"},stdin:Buffer.from(n),output:Ze});…
```
Docker requests (`jH` @521006) read the Mac's `~/.docker/config.json` and run its helper:
```js
if("auth"in a){…let[u,f]=Buffer.from(a.auth,"base64").toString().split(":");return{stdout:JSON.stringify({ServerURL:s,Username:u,Secret:f}),stderr:"",code:0}}o=`docker-credential-${a.helper}`;let{stdout:c,stderr:l}=await ce({exec:e.exec,cmd:o,args:t.slice(1),stdin:Buffer.from(n),output:Ze});
```
The client (`remoteContainersCLI.js`) exports only `getCredential`. It exits at once when the variable is empty:
```js
f=process.env.REMOTE_CONTAINERS_IPC;…async function d(e,n){let t=await S({args:e,stdin:n});t||process.exit(-1);…}function S(e){return new Promise(n=>{let t=JSON.stringify(e);if(!f){n(void 0);return}let s=g.request({socketPath:f,path:"/",method:"POST"},…
```
Settings decide only whether this channel is **wired** into Git, Docker and `gh`:
- **Git helper** (`MS` @591830): configured with `--system` early and with `--global` later. The shell has the container environment, so with our `GIT_CONFIG_GLOBAL` the `--global` write lands in the volume's `/workspaces/.devenv+/gitconfig`:
  ```js
  async function MS(e,t,n,r){if(t||Cl)if(r==="none")n.write("Git credential helper not enabled.");else{…await o.exec(`command -v git >/dev/null 2>&1 && git config --${r} --replace-all credential.helper '!f() { ${e.nodeExecutable} ${t} git-credential-helper $*; }; f' || true`)…}}
  ```
- **Docker helper** (in `QB`): written when the Mac's Docker config has `credsStore`, `credHelpers` or `auths`. It sets `credsStore` in the container's `~/.docker/config.json`.
- **`gh` login** (`rre` @538175): not an IPC request. It is a one-time push at attach, `gh auth token` on the Mac → `gh auth login --with-token` in the container, and only when `gh auth status` fails there.
- **Socket rewiring** (`are` @538999): when VS Code adopts a process, Dev Containers reads that process's `REMOTE_CONTAINERS_IPC`/`SSH_AUTH_SOCK` and links the old paths to the new sockets. With `''` in the environment (`a&&…`) it does nothing.

**Exposure:** the socket is created by the helper running as the remote user (`on(g,…)` with `g = remoteExec` of the container user). The remote user and root can connect; other users need write permission on the socket. Because `store` and `erase` are passed on, a process can also **overwrite or delete** the Mac's github.com credential and its Docker credentials, not only read them.

## 2. How the browser, `openExternal` and "Open in Browser" reach the Mac

In extension.js, `BROWSER` appears only in the Copilot instruction text (`Use \`"$BROWSER" <url>\` to open a webpage in the host's default browser.`, inside `voe`). `VSCODE_IPC_HOOK_CLI` and `without-browser-env-var` do not appear at all. Dev Containers neither sets nor handles the browser.

The VS Code server 1.139.0 (`server-main.js`) sets `BROWSER` for the extension host **after** merging the resolver environment. `remoteEnv` therefore cannot remove or change it:
```js
let c={...process.env,...a,...r,VSCODE_ESM_ENTRYPOINT:…},…n.args["without-browser-env-var"]||(c.BROWSER=z(u,"helpers",ne?"browser.cmd":"browser.sh")),…
```
Each remote terminal gets its own command-line socket:
```js
let E=ol();b.VSCODE_IPC_HOOK_CLI=E;let w=await this._ptyHostService.createProcess(…),k={executeCommand:(U,...fe)=>this._executeCommand(w,U,fe,e)},P=new Fh(k,this._logService,E);
```
`bin/helpers/browser.sh` runs:
```sh
"$ROOT/node" "$CLI_SCRIPT" "$APP_NAME" "$VERSION" "$COMMIT" "$EXEC_NAME" "--openExternal" "$@"
```
`out/server-cli.js` (the same program also backs `bin/remote-cli/code`) posts to `VSCODE_IPC_HOOK_CLI`:
```js
ht=process.env.VSCODE_IPC_HOOK_CLI … if(ht&&s.openExternal){await U1(s._,a);return} … n.length&&await qt({type:"openExternal",uris:n},e) … let o={socketPath:ht,path:"/",method:"POST",…
```
The remote extension host (`extensionHostProcess.js`) starts the same kind of command-line server for processes it spawns (tasks, debugging) and forwards to the window:
```js
if(this._initData.remote.isRemote&&this._initData.remote.authority){let o=this._instaService.createInstance(Qh);process.env.VSCODE_IPC_HOOK_CLI=o.ipcHandlePath}
async openExternal(t){for(let e of t.uris)y.parse(e).scheme!=="file"&&await this._commands.executeCommand("_remoteCLI.openExternal",e)}
```
In the window (`workbench.desktop.main.js`), terminals may use only this allow-list of commands:
```js
qe.registerCommand("_remoteCLI.openExternal",function(s,o){return s.get(Ye).open(He(o)?o:A.revive(o),{openExternal:!0,allowTunneling:!0})});
let v=["_remoteCLI.openExternal","_remoteCLI.windowOpen","_remoteCLI.getSystemStatus","_remoteCLI.manageExtensions"];
```
`vscode.env.openExternal` from an extension in the container arrives as `MainThreadWindow.$openUri`:
```js
async $openUri(o,e,t){…return this.openerService.open(n,{openExternal:!0,allowTunneling:t.allowTunneling,allowContributedOpeners:t.allowContributedOpeners})}
```
"Open in Browser" in the Ports view opens the tunnel's local URI without involving the container:
```js
i.ID="remote.tunnel.open",…function t(n,r,a){let c=n.forwarded.get(a)||n.detected.get(a);return c?r.open(c.localUri,{allowContributedOpeners:!1}):Promise.resolve()}
```
Port forwarding:
- Dev Containers forwards the VS Code server port through a local `net` server plus `docker exec node -e "net.createConnection({ host: '127.0.0.1', port: … })"` (`hW` @574854).
- Published Docker ports are reported as `environmentTunnels` (`dp` @730813).
- The window forwards application ports over the server connection.

None of these uses the IPC socket.

**Precedence of `remoteEnv`:** the configuration's `remoteEnv` is applied last in both places that matter:
- The server/extension-host environment, in `Tl` (@586211): `({...C,...f,...await tj(t,C),REMOTE_CONTAINERS:"true",...vW(e.cliHost.platform,n.configFilePath,t.env,r.remoteEnv||{})})`, where `f` holds `REMOTE_CONTAINERS_IPC`.
- Lifecycle commands started by Dev Containers, in the bundled CLI: `function eQ(e,A,t){return b_(e,A,t).then(i=>({...i,...e.remoteEnv,...t.remoteEnv}))}`, where `e.remoteEnv` is Dev Containers' `--remote-env`.

`vW` keeps `''` as `''`.

**Nothing else reads the variable.** A search for `REMOTE_CONTAINERS` gave 0 hits in `server-main.js`, `server-cli.js`, `extensionHostProcess.js` and `workbench.desktop.main.js`. A search for `REMOTE_CONTAINERS_IPC` gave 0 hits in VS Code's built-in extensions and 0 in the user's other installed extensions under `~/.vscode/extensions`.

**Conclusion:** `REMOTE_CONTAINERS_IPC=''` in `remoteEnv` keeps `$BROWSER`, `code`, `openExternal`, "Open in Browser" and port forwarding working. The docs that say the IPC socket serves the browser are wrong.

## 3. Settings per container versus user settings only

The per-container settings object (`var kv` @585962) and the key helpers (@524179):
```js
var kv=class{constructor(t){this.settings=t}settings;getConfiguration(t){return this.settings[ms(t)]||this.settings[wl(t)]}getNewConfiguration(t){return this.settings[ms(t)]}getDotfileConfiguration(t){return this.settings[wl(t)]||this.settings[t]}};
function wl(e){return`remote.containers.${e}`}function ms(e){return`dev.containers.${e}`}
```
It is built from the container's machine settings (`voe` @589299). The file is written only when the marker is new and the file does not exist yet:
```js
async function voe(e,t,n){var s;let r=Mi(t),o=Ne.posix.join(r,".writeMachineSettingsMarker"),i=VS(t);if(await US(t.shellServer,o)&&!await Ai(t.shellServer,i)){let a=(s=n.customizations)==null?void 0:s.vscode,c=(Array.isArray(a)?a:a?[a]:[]).map(m=>m.settings).filter(Boolean),…;c.push({"github.copilot.chat.codeGeneration.instructions":…});let d=Coe(c);if(Eoe(d,n.portsAttributes),Soe(d,n.otherPortsAttributes),Object.keys(d).length)return await t.shellServer.exec(`mkdir -p '${Ne.posix.dirname(i)}' && cat >'${i}' <<'settingsJSON'
…`),new kv(d)}try{let{stdout:a}=await t.shellServer.exec(`cat ${i}`);return new kv(Qe(a)||{})}catch{return new kv({})}}
function Mi(e){return Ne.posix.join(typeof e=="string"?e:e.userDataFolder,"data/Machine")}function VS(e){return Ne.posix.join(e.userDataFolder,"data/Machine/settings.json")}
async function US(e,t){try{return await e.exec(OS(t)),!0}catch{return!1}}function OS(e){return`test ! -f '${e}' && set -o noclobber && mkdir -p '${Ne.posix.dirname(e)}' && { > '${e}' ; } 2> /dev/null`}
function Coe(e){…return Object.assign({},...e,t)}
```
- `userDataFolder` is `<home>/.vscode-server`.
- `Coe` lets later entries win. The override's metadata entry is the last one, so its settings win over those of the base image, Features and repository.

The attach flow (`fz` @858742) obtains exactly this merged configuration from the label:
```js
b=await li(w,["set-up","--container-id",t.Id,…,"--include-configuration","--include-merged-configuration"]);…let k=b.mergedConfiguration,I=k.remoteUser;m=await mp(e,t.Id,k.workspaceFolder,I);…await Tl(a,m,n,k,U,pp(…))
```
The CLI copies `customizations` (and `remoteEnv`) of the override into the label. In CLI 0.89.0 (pickConfigProperties):
```js
var vj=["onCreateCommand","updateContentCommand","postCreateCommand","postStartCommand","postAttachCommand","waitFor","customizations","mounts","containerEnv","containerUser","init","privileged","capAdd","securityOpt","remoteUser","userEnvProbe","remoteEnv","overrideCommand","portsAttributes","otherPortsAttributes","forwardPorts","shutdownAction","updateRemoteUserUID","hostRequirements"]
```
Where the four settings are read (`Tl`, and `sS` above):
```js
h=a.getConfiguration("gitCredentialHelperConfigLocation")??e.credentialHelperConfigLocation;t.nodeExecutable&&(await dv(e,t,[".ssh","known_hosts"],"ssh"),h!=="none"&&await MS(t,u,e.output,"system"));
…i||await EW(e,t,g,d,a),t.nodeExecutable&&((a.getConfiguration("copyGitConfig")??e.isCopyGitConfigEnabled)&&await YE(e,t,g.then(V=>({...t.env,...V}))),await MS(t,u,e.output,h))
…N=a.getDotfileConfiguration("dotfiles.repository")||e.dotfilesConfiguration.repository
```
The user-level fallbacks (`Ht` @754158; `$ue`, `Mue`, `Hue`, `Bue` @772033):
```js
function Ht(e){let t=ib.workspace.getConfiguration(),n=ms(e),r=t.get(n),o=wl(e),i=t.get(o);if(i!=null&&i!==r){let s=t.inspect(n);if(!s||s.globalValue===void 0&&s.workspaceValue===void 0&&s.workspaceFolderValue===void 0)return i}return r}
function $ue(){let e=Ht("copyGitConfig");return typeof e=="boolean"?e:!0}function Mue(){return Ht("gitCredentialHelperConfigLocation")||"global"}function Hue(){let e=Ht("dockerCredentialHelper");return typeof e=="boolean"?e:!0}function Bue(){let e=Ht("githubCLILoginWithToken");return typeof e=="boolean"?e:!0}
```
In `package.json`, all four settings and `dotfiles.*` are scope `machine`:
- Defaults: `copyGitConfig` true, `gitCredentialHelperConfigLocation` `"global"`, `dockerCredentialHelper` true, `githubCLILoginWithToken` false.
- `remote.containers.copyGitConfig` still exists but is deprecated.
- There is no `remote.containers.dockerCredentialHelper` and no `remote.containers.githubCLILoginWithToken`.

Results of `g3-kv-check.mjs` (the verbatim code, with a user who switched every forwarding on):

| Container settings | copyGitConfig | gitCredentialHelperConfigLocation | dockerCredentialHelper | githubCLILoginWithToken | dotfiles |
|---|---|---|---|---|---|
| none | true | global | true | true | user's |
| new keys only (false / none) | **true** (falls back) | none | false | false | user's |
| old keys only | false | none | **true** | **true** | user's |
| recommended five keys | false | none | false | false | user's |
| repository `dev.containers.copyGitConfig: true` + override old key only | **true** | global | true | true | user's |
| same repository + override with the recommended five keys | false | none | false | false | user's |
| `dotfiles.repository: ''` (both spellings) | – | – | – | – | **user's** |

**User settings only** (read only through `Ht`): bootstrapImage, bootstrapImagePull, cacheVolume, defaultFeatures, dockerComposePath, dockerPath, dockerSocketPath, enableWebAccess, executeInWSL, executeInWSLDistro, experimentalMountGitWorktreeCommonDir, forwardWSLServices, gpuAvailability, lockfile, logLevel, mountWaylandSocket, optimisticallyLaunchDocker, repositoryConfigurationPaths and workspaceMountConsistency. `defaultExtensions` is also user level (scope application).

**No setting at all** gates these:
- SSH agent forwarding (`tre`: always, when the Mac has an agent).
- X11 forwarding (skipped only when the container's own environment has a non-empty `DISPLAY`; see section 6).
- GPG agent forwarding (skipped when the container's GnuPG home has private keys).
- The copy of `~/.ssh/known_hosts`.

**Limits of per-container settings:**
- The machine settings file belongs to the remote user. A process or the user can change or delete it. After deletion, Dev Containers does not rewrite it (the marker exists); `cat` fails, so the user settings apply.
- An image that ships its own `~/.vscode-server/data/Machine/settings.json` keeps its values.
- These keys are scope `machine`, which the window accepts from remote machine settings. So inside such a window they may also change what the local Dev Containers extension reads through `Ht`, but only for that window (not verified at runtime). The global user settings stay unchanged.

The settings are therefore a hygiene layer, not a boundary. That is why the existing guards stay.

## 4. The exact copyGitConfig skip rule

`YE` (@516211) handles both files:
```js
async function YE(e,t,n){let r=await dv(e,t,[".gitconfig"],"git"," && grep -e '^\\[' ~/.gitconfig | grep -v -E '^\\[(filter|safe)([[:blank:]]+|\\])'"),o=await Xte(e,t,n);(r||o)&&(await Zte(e,t.shellServer),Qte(e,t).catch(…))}
```
`dv` (@592280) returns early when the Mac has no `~/.gitconfig`, and otherwise calls `vl`. `vl` (@592603) tests the target, then **appends** exactly the bytes of the Mac's file (`Df` = `dd iflag=fullblock …`):
```js
async function dv(e,t,n,r,o){let{cliHost:i}=e,s=i.path.join(await i.homedir(),...n);if(!await i.isFile(s)&&(i.type==="local"||…))return!1;let a=Ne.posix.join(t.homeFolder,...n);return vl(i,t.shellServer,s,a,r,o)}
async function vl(e,t,n,r,o,i=""){let s=await _oe(e,n);if(s)try{let a=await r,c=Ne.posix.dirname(a);return await t.exec(`# Test for ${a} and ${o}
[ -e '${a}' ] ${i}&& echo '${a}' exists && exit 1
command -v ${o} >/dev/null 2>&1 || (echo ${o} not found && exit 1) || exit 1
mkdir -p '${c}'
[ -w '${c}' ] || (echo '${c}' not writable && exit 1) || exit 1`),await t.exec(`# Copy ${n} to ${a}
${Df(s.byteLength)} >>'${a}'`,{stdin:s}),!0}catch(a){if(a&&a.code!==1)throw a}return!1}
```
**Rule for `~/.gitconfig`:** the copy is skipped (exit 1) if and only if all of these hold:
- the target `<homeFolder>/.gitconfig` exists (any type; a link is followed);
- `grep -e '^\['` finds at least one line starting at column 0 with `[`;
- at least one of those lines does not match `^\[(filter|safe)([[:blank:]]+|\])`. Matching is case-sensitive, and the filter/safe name must be followed by a blank or `]`.

The grep reads `~/.gitconfig` through the shell's `$HOME`; the `-e` test uses `t.homeFolder`. In any other case the Mac's file is appended, as long as `git` exists in the container and the folder is writable.

`g3-copycheck.py`, running the verbatim script with sh and grep, gave:

| Result | Sample files |
|---|---|
| Copy | missing file, empty file, only comments, `[safe]`, `[filter "lfs"]`, `[filter]` + `[safe]`, `  [user]` (indented), `[safe "x"]` |
| Skip | the Dev Environments content (`[credential]` + `[include]`), `[include]`, `[core]`, `[Filter "lfs"]`, `[filterx]` |

The constant `DEV_CONTAINERS_GITCONFIG_CHECK` in `containerGit.ts` matches this rule. The current `HOME_GIT_CONFIG_CONTENT` stops the copy.

**Rule for `~/.config/git/config`** (`Xte`, `vl` with no extra check): the copy is skipped whenever the target exists, even if it is empty. The target is `$XDG_CONFIG_HOME/git/config` when the **remote environment** (image `ENV`, login shell or `remoteEnv`) sets `XDG_CONFIG_HOME`; otherwise it is `<home>/.config/git/config`:
```js
let s=await n,a=s.XDG_CONFIG_HOME?[s.XDG_CONFIG_HOME]:[t.homeFolder,".config"];return JP.posix.join(...a,...AH)
```
**Gap in the current guard:** `HOME_GIT_CONFIG_SCRIPT` creates only `$home/.config/git/config`. With an image that sets `XDG_CONFIG_HOME` elsewhere, the Mac's `~/.config/git/config`, if it exists, is copied there. Git older than 2.32 reads it.

**Side effects after any copy (`r||o`):**
- `Zte` runs `git config --global --unset …`.
- `Qte` copies the allowed-signers file and runs `git config --global gpg.ssh.allowedSignersFile …`.

That shell has `GIT_CONFIG_GLOBAL`, so both write into the volume's gitconfig. `remote.containers.copyGitConfig: false` plus `dev.containers.copyGitConfig: false` stops the whole `YE` call, including the XDG case.

## 5. Recommendation for gap 3 (keeps requirement (a))

**1. Add `customizations.vscode.settings` to the override** (`buildOverrideConfig`, always, also with `devenv.container-config=unknown`). The values come from a new pure function in `src/core/helper/containerGit.ts`, for example `devContainersSettings()`. Keys must be **flat dotted keys**, not nested objects, because `kv` reads `this.settings["dev.containers.copyGitConfig"]`.
   ```json
   "customizations": { "vscode": { "settings": {
     "dev.containers.copyGitConfig": false,
     "remote.containers.copyGitConfig": false,
     "dev.containers.gitCredentialHelperConfigLocation": "none",
     "dev.containers.dockerCredentialHelper": false,
     "dev.containers.githubCLILoginWithToken": false
   } } }
   ```
   What each key does:
   - `remote.containers.copyGitConfig: false` is the value the `||` falls through to.
   - `dev.containers.copyGitConfig: false` defeats a repository's, Feature's or image's `dev.containers.copyGitConfig: true`; with `true || false` the copy would happen.
   - `gitCredentialHelperConfigLocation: "none"` stops both `git config --system` and `--global`. As a result, Dev Containers no longer writes into the volume's gitconfig, and the log shows "Git credential helper not enabled."
   - `dockerCredentialHelper: false` stops writing `/usr/local/bin/docker-credential-dev-containers-*` and the `credsStore` entry.
   - `githubCLILoginWithToken: false` stops pushing the Mac's `gh` token.

   Quote the `kv` class verbatim in the doc comment, as is done for `DEV_CONTAINERS_GITCONFIG_CHECK`. Add `// Assumption (V-8): Dev Containers writes customizations.vscode.settings of the container label into ~/.vscode-server/data/Machine/settings.json at the first attach and reads these keys from it.`

**2. Set `REMOTE_CONTAINERS_IPC: ''` in `remoteEnvironment()`** (`remoteEnv` only; `containerEnv` gains nothing, because the server sets its own value on its command line).
   - Effect: the in-container client exits (`if(!f)` → `process.exit(-1)`). A forwarding helper that still exists (from the image, dotfiles, the user, or a machine settings file someone changed) cannot find the socket through the variable.
   - The VS Code server, terminals, extensions and lifecycle commands started by Dev Containers all see `''`.
   - It does not affect `$BROWSER`, `code`, `openExternal`, Open in Browser, port forwarding or the SSH/GPG/X11 sockets (section 2).

   Update the comment "BROWSER stays: …": `BROWSER` and `VSCODE_IPC_HOOK_CLI` are VS Code's channels and are not touched; `REMOTE_CONTAINERS_IPC` carries only credentials. Mark it `// Assumption (V-8)`.

**3. Raise `CONTAINER_VERSION` to 3** in `names.ts`, for example "3: Dev Containers settings of the container and no REMOTE_CONTAINERS_IPC".
   - Why: the settings and `remoteEnv` live in the container's label, and the machine settings file is written only at the first attach of a new container. Without the bump, existing environments keep the old behaviour until they are created again.
   - One bump covers every change of this wave.
   - Cost: the known one-time re-creation. Data outside `/workspaces` is lost, `onCreate`/`postCreate` run again, and the progress says so.

**4. Keep the existing guards unchanged:** `HOME_GIT_CONFIG_SCRIPT`, `GIT_CONFIG_GLOBAL`/`PARAMETERS`/`COUNT`, `DOCKER_CONFIG`, `GNUPGHOME`, `GIT_SSH_COMMAND` and `SSH_AUTH_SOCK=''`. They cover Git older than 2.32, plain `docker exec`, changed or deleted machine settings, and images that ship their own machine settings.

**5. Document what remains (known limit):**
- The socket `${TMPDIR:-/tmp}/vscode-remote-containers-ipc-<uuid>.sock` and the client `/tmp/vscode-remote-containers-<uuid>.js` stay in every attached container. A process of the remote user (or root) that looks for them can still read, store or delete the Mac's Git and Docker credentials.
- The Mac's own credential helpers decide what `git credential fill` returns.
- This is the same class of limit as the SSH agent socket file. Full isolation needs a separate macOS user, a VM or Enhanced Container Isolation.

**Tests (table-driven, pure):**
- `devContainersSettings()`: each key and value, both `copyGitConfig` keys, flat keys.
- `buildOverrideConfig`: contains `customizations.vscode.settings`, also for the unknown-configuration override.
- `remoteEnvironment()`: `REMOTE_CONTAINERS_IPC === ''`, and neither `BROWSER` nor `VSCODE_IPC_HOOK_CLI` present (requirement (a)).
- `CONTAINER_VERSION` label value.
- Docker test: the container's `devcontainer.metadata` label has, in its last entry, the five settings and `remoteEnv.REMOTE_CONTAINERS_IPC === ""`, and `devenv.container-version=3`.

**Docs to correct:**

`docs/vscode-dev-environments.md`:
- 836: add that forwarding is switched off per container through Dev Containers settings of that container (no copy of the Git configuration, no Git or Docker credential helper, no GitHub CLI sign-in) as well as through the container's environment variables; the global settings stay unchanged.
- 846: replace "The channel of the Dev Containers extension for this (`REMOTE_CONTAINERS_IPC`) is kept on purpose." with: they use VS Code's own channels (the connection of the VS Code server and its command-line socket), not the channel of the Dev Containers extension.
- 849: replace "the channel `REMOTE_CONTAINERS_IPC` with `$BROWSER` and `code`" with: the socket and helper script of the Dev Containers extension in `/tmp`, which answer requests for the Git and Docker credentials of the computer, including storing or deleting them.
- 887 (V-8): add the checks listed below.

`docs/container-restrictions.md`:
- 68/69/71: add the per-container settings (Kind: Rewritten).
- New row: `gh` login and `REMOTE_CONTAINERS_IPC=''`.
- 99: copyGitConfig, the credential helpers and `gh` no longer "still apply"; dotfiles and defaultExtensions do.
- 115: the limit text as in 849.
- 119: remove `gh` from "Not restricted yet".
- 127: gap 3 → "Fixed: …". Delete "The channel itself stays: `$BROWSER`, `openExternal`, and the IPC socket must keep working …".
- Status line 16.

`docs/implementation-notes.md`:
- §8, override contents: add `customizations.vscode.settings`, `REMOTE_CONTAINERS_IPC=''` and `devenv.container-version=3`.

Code comments:
- `containerGit.ts` lines 5–9 and 97–103.
- `buildOverrideConfig` doc comment (lists the override contents).
- `names.ts` `CONTAINER_VERSION`.

**Checks in real VS Code** (to add to V-8), for a newly created environment:
- In the integrated terminal: `echo "[$REMOTE_CONTAINERS_IPC]"` prints `[]`.
- `"$BROWSER" https://example.com` opens the Mac's browser.
- `code README.md` opens the file.
- A server started with `python3 -m http.server 8000`: "Open in Browser" in the Ports view opens `localhost:8000` on the Mac.
- An extension's `openExternal` still opens the browser.
- `~/.vscode-server/data/Machine/settings.json` contains the five keys.
- The Dev Containers log contains "Git credential helper not enabled." and no "Setting up GitHub CLI".
- `git config --system --get-all credential.helper` and `git config --file /workspaces/.devenv+/gitconfig --get-all credential.helper` show no `vscode-remote-containers` helper.
- There is no `/usr/local/bin/docker-credential-dev-containers-*`.
- `~/.gitconfig` is unchanged.
- Do **not** test the remaining socket with a real credential.

**Rejected alternatives:**
- **Deleting the socket after attach** (a `postAttachCommand`): the server creates it again at every reconnect (`rm -f '${s}' ; … REMOTE_CONTAINERS_IPC='${s}'` in `Jne`, and `D()` relaunches). A process waiting since `postStart` connects first. Not a boundary.
- **Pointing `TMPDIR` at an unwritable folder:** the IPC listen fails, `Promise.all(kn)` never resolves, and `ready` never comes. Lifecycle commands and dotfiles wait for it, so the attach breaks. It also moves the SSH, X11 and GPG sockets.
- **Changing `BROWSER` or `VSCODE_IPC_HOOK_CLI`:** breaks (a). The server resets `BROWSER` anyway.
- **Changing the user's global Dev Containers settings:** would affect the user's other dev containers.
- **`dev.containers.copyGitConfig: false` alone:** no effect.
- **Old keys for docker and gh:** no effect.

## 6. Related findings (outside gap 3; for the orchestrator to schedule)

1. **A repository can make VS Code forward ports on all interfaces of the Mac.**
   - Any `customizations.vscode.settings` (repository, Feature or base-image label) become machine settings of the container.
   - The window applies remote machine settings with scopes `mBe=[2,3,4,5,6,7]`, which includes window scope 4: `new kAt(c.settingsPath,{scopes:mBe},…)`.
   - `remote.localPortHost` has no scope, so it is window scope: `registerConfiguration({id:"remote",…"remote.localPortHost":{type:"string",enum:["localhost","allInterfaces"],default:"localhost",…}`.
   - The tunnel service then uses `get defaultTunnelHost(){let e=this.configurationService.getValue("remote.localPortHost");return!e||e==="localhost"?"127.0.0.1":"0.0.0.0"}`.

   So `"remote.localPortHost": "allInterfaces"` exposes forwarded ports to the LAN. Proposal: the host access policy refuses a merged configuration whose settings set it to anything other than `"localhost"`. Do not force the value in the override: machine settings would override the user's own choice. Other window-scoped settings, such as `remote.extensionKind`, reach the window the same way and need their own review.
2. **X11:** Dev Containers forwards X11 unless the container's own environment has a non-empty `DISPLAY`: `g=(F=t.env)!=null&&F.DISPLAY?void 0:zne(u,de=>nre(de,i))`, with `t.env` = `qie(c.Config.Env)` from `docker inspect` (`mp`). A non-empty `DISPLAY` in `containerEnv` would stop it; `DISPLAY=''` in `remoteEnv` does not.
3. **`~/.ssh/known_hosts`:** copied at every attach when the container has none and has `ssh` (`dv(e,t,[".ssh","known_hosts"],"ssh")`, no setting). Any existing file, even an empty one, stops it. It can be blocked like `~/.config/git/config`.
4. **Dotfiles:** cannot be switched off per container (section 3).
5. **Known-limit wording:** the text on the Dev Containers channels should say that credentials can be read **and** stored or deleted (`approve`/`reject`, Docker `store`/`erase`).
