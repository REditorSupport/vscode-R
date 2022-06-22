export { ExecutableQuickPick } from './quickpick';
export { ExecutableStatusItem } from './status';

export enum ExecutableNotifications {
    badFolder = 'Supplied R executable directory is not a valid R directory.',
    badConfig = 'Configured path is not a valid R executable directory.'
}