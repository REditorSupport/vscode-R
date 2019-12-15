var jsonTable = jsonTable || {};

jsonTable = {
  init: function (data, options) {
    options = options || {};
    var container = options.container || "table-container";
    var datatables_options = options.datatables_options || {};
    var $table = $("<table class='table table-sm table-striped table-condensed'></table>");
    var $container = $("#" + container);
    $container.empty().append($table);
    var $tableHead = $("<thead></thead>");
    var $tableHeadRow = $("<tr></tr>");
    for (var colId = 0; colId < data.size[1]; colId++) {
      var $tableHeadColumn = $("<th></th>")
        .text(data.columns[colId]);
      if (data.types[colId] === "character") {
        $tableHeadColumn.addClass("left");
      }
      $tableHeadRow.append($tableHeadColumn);
    }
    $tableHead.append($tableHeadRow);
    $table.append($tableHead);
    var $tableBody = $("<tbody></tbody>");
    for (var rowId = 0; rowId < data.size[0]; rowId++) {
      var $tableBodyRow = $("<tr></tr>");
      for (var colId = 0; colId < data.size[1]; colId++) {
        var $tableRowCell = $("<td></td>")
          .text(data.data[colId][rowId]);
        if (data.types[colId] === "character") {
          $tableRowCell.addClass("left");
        }
        $tableBodyRow.append($tableRowCell);
      }
      $tableBody.append($tableBodyRow);
    }
    $table.append($tableBody);
    $table.DataTable(datatables_options);
  }
};
