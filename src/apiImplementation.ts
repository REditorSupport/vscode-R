import { RHelp } from './helpViewer';
import { RExtension, RSessionApi } from './api';
export class RExtensionImplementation implements RExtension  {
    public helpPanel?: RHelp;
    public session!: RSessionApi;
}


