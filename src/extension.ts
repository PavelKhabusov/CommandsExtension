import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';
import { CommandsSidebarProvider } from './sidebarProvider';
import { TerminalManager } from './terminalManager';

export function activate(context: vscode.ExtensionContext): void {
  // Register the editor panel command
  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri, context);
    }
  );
  context.subscriptions.push(openPanelCommand);

  // Register the sidebar webview provider
  const sidebarProvider = new CommandsSidebarProvider(context.extensionUri, context);
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    CommandsSidebarProvider.viewType,
    sidebarProvider
  );
  context.subscriptions.push(sidebarRegistration);

  // Register terminal manager disposables for cleanup
  context.subscriptions.push(...TerminalManager.getInstance().getDisposables());

  // Watch for changes to commands-list.json and package.json
  if (vscode.workspace.workspaceFolders) {
    const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');

    const commandsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], configFile)
    );

    const packageWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], 'package.json')
    );

    const onFileChange = () => {
      // Refresh both the editor panel and the sidebar
      CommandsPanel.refresh();
      sidebarProvider.refresh();
    };

    commandsWatcher.onDidChange(onFileChange);
    commandsWatcher.onDidCreate(onFileChange);
    commandsWatcher.onDidDelete(onFileChange);

    packageWatcher.onDidChange(onFileChange);
    packageWatcher.onDidCreate(onFileChange);
    packageWatcher.onDidDelete(onFileChange);

    context.subscriptions.push(commandsWatcher, packageWatcher);
  }
}

export function deactivate(): void {}
