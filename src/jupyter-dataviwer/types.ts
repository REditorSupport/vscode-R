// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IRowsResponse = any[];

export enum ColumnType {
    String = 'string',
    Number = 'num',
    Bool = 'bool'
}

export interface IDataViewerDataProvider {
    dispose(): void;
    getDataFrameInfo(sliceExpression?: string, isRefresh?: boolean): Promise<IDataFrameInfo>;
    getAllRows(sliceExpression?: string): Promise<IRowsResponse>;
    getRows(start: number, end: number, sliceExpression?: string): Promise<IRowsResponse>;
}