import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';
import { CommandsSidebarProvider } from './sidebarProvider';
import { TerminalManager } from './terminalManager';
import { UploadRunner } from './uploadRunner';
import { UploadProgress } from './uploadsTypes';

type ProgressListener = (p: UploadProgress) => void;

class UploadProgressBus {
  private readonly _listeners = new Set<ProgressListener>();
  emit(p: UploadProgress): void {
    for (const l of this._listeners) l(p);
  }
  subscribe(l: ProgressListener): vscode.Disposable {
    this._listeners.add(l);
    return new vscode.Disposable(() => this._listeners.delete(l));
  }
}

export const uploadProgressBus = new UploadProgressBus();
export let uploadRunner: UploadRunner | undefined;

export function activate(context: vscode.ExtensionContext): void {
  uploadRunner = new UploadRunner((p) => uploadProgressBus.emit(p));

  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri, context);
    }
  );
  context.subscriptions.push(openPanelCommand);

  const sidebarProvider = new CommandsSidebarProvider(context.extensionUri, context);
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    CommandsSidebarProvider.viewType,
    sidebarProvider
  );
  context.subscriptions.push(sidebarRegistration);

  context.subscriptions.push(...TerminalManager.getInstance().getDisposables());

  if (vscode.workspace.workspaceFolders) {
    const config = vscode.workspace.getConfiguration('commandsExtension');
    const configFile = config.get<string>('configFile', 'commands-list.json');
    const uploadsFile = config.get<string>('uploadsFile', 'server-uploads.local.json');

    const commandsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], configFile)
    );
    const packageWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], 'package.json')
    );
    const uploadsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], uploadsFile)
    );
    const ps1Watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '*.ps1')
    );

    const onFileChange = () => {
      CommandsPanel.refresh();
      sidebarProvider.refresh();
    };

    for (const w of [commandsWatcher, packageWatcher, uploadsWatcher, ps1Watcher]) {
      w.onDidChange(onFileChange);
      w.onDidCreate(onFileChange);
      w.onDidDelete(onFileChange);
    }

    context.subscriptions.push(commandsWatcher, packageWatcher, uploadsWatcher, ps1Watcher);
  }
}

export function deactivate(): void {}
