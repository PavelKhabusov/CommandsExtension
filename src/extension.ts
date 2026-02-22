import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(openPanelCommand);

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
      CommandsPanel.refresh();
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
