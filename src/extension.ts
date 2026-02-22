import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';
import { CommandsSidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  // Register the editor panel command
  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri);
    }
  );
  context.subscriptions.push(openPanelCommand);

  // Register the sidebar webview provider
  const sidebarProvider = new CommandsSidebarProvider(context.extensionUri);
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    CommandsSidebarProvider.viewType,
    sidebarProvider
  );
  context.subscriptions.push(sidebarRegistration);

  // Watch for changes to commands.json and package.json
  if (vscode.workspace.workspaceFolders) {
    const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands.json');

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
