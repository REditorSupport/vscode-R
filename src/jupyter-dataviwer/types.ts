// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { Event } from 'vscode';

export const CellFetchAllLimit = 100000;
export const CellFetchSizeFirst = 100000;
export const CellFetchSizeSubsequent = 1000000;
export const MaxStringCompare = 200;
export const ColumnWarningSize = 1000; // Anything over this takes too long to load

export interface IGetRowsRequest {
    start: number;
    end: number;
    sliceExpression?: string;
}

export interface IGetRowsResponse {
    rows: IRowsResponse;
    start: number;
    end: number;
}

export interface IGetSliceRequest {
    slice: string | undefined;
    source: SliceOperationSource;
}

export enum SliceOperationSource {
    Dropdown = 'dropdown',
    TextBox = 'textbox',
    Checkbox = 'checkbox'
}

export interface IDataFrameInfo {
    columns?: { key: string; type: ColumnType }[];
    indexColumn?: string;
    rowCount?: number;
    shape?: number[];
    originalVariableShape?: number[];
    dataDimensionality?: number;
    sliceExpression?: string;
    maximumRowChunkSize?: number;
    type?: string;
    originalVariableType?: string;
    name?: string;
    /**
     * The name of the file that this variable was declared in.
     */
    fileName?: string;
}

export interface IRDataFrameInfo{
    columns?: { title: string; className: string; type: ColumnType }[];
    rowCount?: number[];
    data?: IRowsResponse[];
    shape?: number[];
    type?: string[];
    name?: string[];
    fileName?: string[];
}

export interface IDataViewerDataProvider {
    dispose(): void;
    getDataFrameInfo(sliceExpression?: string, isRefresh?: boolean): Promise<IDataFrameInfo>;
    getAllRows(sliceExpression?: string): Promise<IRowsResponse>;
    getRows(start: number, end: number, sliceExpression?: string): Promise<IRowsResponse>;
}

export enum ColumnType {
    String = 'string',
    Number = 'num',
    Bool = 'bool'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IRowsResponse = any[];

export const IDataViewerFactory = Symbol('IDataViewerFactory');
export interface IDataViewerFactory {
    create(dataProvider: IDataViewerDataProvider, title: string): Promise<IDataViewer>;
}

export const IDataViewer = Symbol('IDataViewer');
export interface IDataViewer extends IDisposable {
    readonly active: boolean;
    readonly onDidDisposeDataViewer: Event<IDataViewer>;
    readonly onDidChangeDataViewerViewState: Event<void>;
    showData(dataProvider: IDataViewerDataProvider, title: string): Promise<void>;
    refreshData(): Promise<void>;
}

export interface IDisposable {
    dispose(): void | undefined;
}