import * as React from 'react';
import { render } from 'react-dom';

import { MDBDataTable } from 'mdbreact';
import '@fortawesome/fontawesome-free/css/all.min.css';
import 'bootstrap-css-only/css/bootstrap.min.css';
import 'mdbreact/dist/css/mdb.css';

const notebookApi = acquireNotebookRendererApi("r-notebook-table-renderer");

const DatatablePage = ({ data }) => {
  const columns = Object.keys(data[0]).map((k) => {
    return {
      label: k.charAt(0).toLocaleUpperCase() + k.slice(1),
      field: k,
      sort: 'asc'
    }
  })
  const datatable = {
    columns: columns,
    rows: data
  }
  return <MDBDataTable small hover entriesOptions={[10, 20, 25]} entries={10} data={datatable} autoWidth />;
}

notebookApi.onDidCreateOutput((evt) => {
    const output = evt.output.data[evt.mimeType];
    render(
      <div style={{ padding: '5px', backgroundColor: "white" }}>
        <DatatablePage data={output}/>
        {/* <DataTable2 data={output} /> */}
      </div> as any, evt.element)
});
