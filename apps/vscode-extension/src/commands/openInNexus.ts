import * as vscode from 'vscode';

export function registerOpenInNexus(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'nexus.openInNexusEditor',
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showErrorMessage('No .xlf file selected.');
          return;
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          'nexus.translationEditor'
        );
      }
    )
  );

  // Toggle commands to change the global default editor association for *.xlf
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'nexus.setNexusAsDefaultXlfEditor',
      async () => {
        const cfg = vscode.workspace.getConfiguration();
        const current = cfg.get<Record<string, string>>('workbench.editorAssociations', {});
        await cfg.update(
          'workbench.editorAssociations',
          { ...current, '*.xlf': 'nexus.translationEditor' },
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          'Nexus Translator is now the default editor for .xlf files. Reopen any .xlf to apply.'
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'nexus.setTextAsDefaultXlfEditor',
      async () => {
        const cfg = vscode.workspace.getConfiguration();
        const current = { ...cfg.get<Record<string, string>>('workbench.editorAssociations', {}) };
        delete current['*.xlf'];
        await cfg.update(
          'workbench.editorAssociations',
          current,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          '.xlf files will now open as raw XML text by default. Right-click → Open With → Nexus Translation Editor to use the UI.'
        );
      }
    )
  );
}
