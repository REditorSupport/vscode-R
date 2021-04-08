/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { IDataFrameInfo, IDataViewerDataProvider, IRDataFrameInfo, IRowsResponse } from './types';
import * as fs from 'fs-extra';

export class DataViewerDataProvider implements IDataViewerDataProvider {
    private file: string;
    protected dataFrameInfo: IDataFrameInfo;
    private rDataFrameInfoData: IRowsResponse[];




    constructor(file: string){
        this.file = file;
    }

    public dispose(): void {
        console.log('disposed');
    }

    public getDataFrameInfo(sliceExpression?: string, isRefresh?: boolean): Promise<IDataFrameInfo> {

        const rDataFrameInfo : IRDataFrameInfo =  JSON.parse(fs.readFileSync(this.file).toString());
        this.rDataFrameInfoData = rDataFrameInfo.data;


        return new Promise<IDataFrameInfo> ((resolve, reject) => resolve(this.convertRDataFrameInfoToDataFrameInfo(rDataFrameInfo)));

    }


    public getAllRows(sliceExpression?: string): Promise<IRowsResponse> {
        const allRows: IRowsResponse = [{col1: 1 ,col2: 1}, {col1: 2 ,col2: 2}];

        return new Promise<IRowsResponse>((resolve, reject) => resolve(allRows));
    }
    public getRows(start: number, end: number, sliceExpression?: string): Promise<IRowsResponse> {

        const rows: IRowsResponse = this.convertRDataFrameInfoDataToRows(this.rDataFrameInfoData);

        return new Promise<IRowsResponse>((resolve, reject) => resolve(rows));

    }

    private convertRDataFrameInfoToDataFrameInfo(rdataFrameInfo : IRDataFrameInfo): IDataFrameInfo {
        const dataFrameInfo : IDataFrameInfo = {
            columns: rdataFrameInfo
                .columns
                .filter((elem, index) => index > 0)
                .map(c => {
                    return {key: c.title, type: c.type};
                }),
            rowCount: rdataFrameInfo.rowCount[0],
            shape: rdataFrameInfo.shape,
            type: rdataFrameInfo.type[0],
            name: rdataFrameInfo.name[0],
            fileName:  rdataFrameInfo.fileName[0]
        };

        this.dataFrameInfo = dataFrameInfo;

        return dataFrameInfo;

    }

    private convertRDataFrameInfoDataToRows(rDataFrameInfoData: IRowsResponse): IRowsResponse {
        return rDataFrameInfoData
            .map(dataRow => {
                const rowObject = {};
                dataRow
                    .filter((dataRowItem, index: number) =>  index > 0)
                    .forEach((dataRowItem, index: number) => {
                        const colName = this.dataFrameInfo.columns[index]['key'];
                        rowObject[colName] = dataRowItem;
                    });
                return rowObject;
            });
          
    }
}

                // return data.filter((elem, index) =>  index > 0)
                // .map((row, index) => {
                //     const colname: { col: string } = {`${this.dataFrameInfo.columns[index]['key']}` : row};
                //     return colname;
                // });