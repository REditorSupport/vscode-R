/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { 
    IDataFrameInfo, 
    IDataViewerDataProvider,
    IRowsResponse } from './types';
import * as rTerminal from '../rTerminal';
import * as fs from 'fs-extra';
import * as path from 'path';

export class DataViewerDataProvider implements IDataViewerDataProvider {
    private file: string;
    private dataFrameInfo: IDataFrameInfo;


    constructor(file: string){
        this.file = file;
    }

    public dispose(): void {
        const filePath = path.dirname(this.file);
        const regex = new RegExp(`^${this.file.split('/')[3]}`);
        fs.readdirSync(filePath)
            .filter(f => regex.test(f))
            .forEach(f => fs.unlinkSync(filePath + path.sep + f));
    }

    public getDataFrameInfo(
        sliceExpression?: string, 
        isRefresh?: boolean): Promise<IDataFrameInfo> {

        this.dataFrameInfo = JSON.parse(
            fs.readFileSync(`${this.file}_info.json`).toString());
        

        return new Promise<IDataFrameInfo> ((resolve) => resolve(this.dataFrameInfo));

    }


    public getAllRows(sliceExpression?: string): Promise<IRowsResponse> {

        return new Promise<IRowsResponse>((resolve) => resolve([]));
    }
    public async getRows(
        start: number, 
        end: number, 
        sliceExpression?: string): Promise<IRowsResponse> {

        await rTerminal.runCommand(`.vsc.get_rows(${start + 1}, ${end}, ${this.dataFrameInfo.name}, "${this.file}")`);
        
        return this.waitUntilFileExistThenRead(`${this.file}_rows_${start + 1}_to_${end}.json`);

    }

    private waitUntilFileExistThenRead(filePath, counter = 0, maxTries = 20, timeOut = 500) {
        return new Promise<IRowsResponse>((resolve, reject) => {
            setTimeout(() => {
                fs.access(filePath, fs.constants.F_OK, (err) => {
                    if (err) {
                        if (counter <= maxTries){
                            // console.log(`counter = ${counter}`);              
                            resolve(this.waitUntilFileExistThenRead(filePath, counter + 1));
                        } else {
                            reject(err);
                        }
                    } else {
                    //file exists
                        resolve(JSON.parse(fs.readFileSync(filePath).toString()));
                    }
                });
            }, timeOut);
        });
    }
}