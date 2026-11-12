import type { Session } from '../session';
export interface PlotViewer {
    readonly id: string;
    readonly isActive?: boolean;
    show(preserveFocus?: boolean): void;
    dispose(keepPanel?: boolean): void;
    handleCommand(command: string, ...args: unknown[]): void | Promise<void>;
}

export interface PlotManager {
    viewers: PlotViewer[];
    activeViewer: PlotViewer | undefined;
    initialize(): Promise<void>;
    showStandardPlot(target: Session, restoring?: boolean): Promise<void>;
    showHttpgdPlot(url: string, target?: Session, restoring?: boolean): Promise<void>;
}
