//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from "assert";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import { extendSelection } from "../src/selection";

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", () => {

    test("Selecting multi-line {} bracketed expression", () => {
        const doc = `
        function (x) {
            y = x
            y
        }
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 4);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
        assert.equal(extendSelection(4, f, doc.length).startLine, 0);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
    });

    test("Selecting two-line () bracketed expression", () => {
        const doc = `
        a = list(x = 1,
            y = 2)
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting three-line () bracketed expression", () => {
        const doc = `
        a = list(x = 1,
            y = 2,
            z = 3)
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 3);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 3);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
    });

    test("Selecting two-line piped expression", () => {
        const doc = `
        1 + 1 %>%
            print()
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting two-line piped expression with gap", () => {
        const doc = `
        1 + 1 %>%

            print()
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 3);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 3);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
    });

    test("Selecting three-line piped expression", () => {
        const doc = `
        1 + 1 %>%
            sum() %>%
            print()
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 3);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 3);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
    });

    test("Selecting nested bracketed expression with brackets on different lines", () => {
        const doc = `
        (
            c(
                2
            )
        )
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 5);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 4);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
        assert.equal(extendSelection(4, f, doc.length).startLine, 2);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
        assert.equal(extendSelection(5, f, doc.length).startLine, 0);
        assert.equal(extendSelection(5, f, doc.length).endLine, 5);
    });

    test("Selecting nested bracketed expression with brackets on same line", () => {
        const doc = `
        {
            c(
                2
            )}
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 4);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 4);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
        assert.equal(extendSelection(4, f, doc.length).startLine, 0);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
    });

    test("Selecting brackets and pipes", () => {
        const doc = `
        {
            1
        } %>%
            c(
                2
            )
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 6);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 6);
        assert.equal(extendSelection(4, f, doc.length).startLine, 0);
        assert.equal(extendSelection(4, f, doc.length).endLine, 6);
        assert.equal(extendSelection(5, f, doc.length).startLine, 5);
        assert.equal(extendSelection(5, f, doc.length).endLine, 5);
        assert.equal(extendSelection(6, f, doc.length).startLine, 0);
        assert.equal(extendSelection(6, f, doc.length).endLine, 6);

        const doc2 = `
        {
            1
        } %>%

            c(
                2
            )
        `.split("\n");
        function f2(i) {return (doc2[i]); }
        assert.equal(extendSelection(1, f2, doc2.length).startLine, 0);
        assert.equal(extendSelection(1, f2, doc2.length).endLine, 7);
        assert.equal(extendSelection(2, f2, doc2.length).startLine, 2);
        assert.equal(extendSelection(2, f2, doc2.length).endLine, 2);
        assert.equal(extendSelection(3, f2, doc2.length).startLine, 0);
        assert.equal(extendSelection(3, f2, doc2.length).endLine, 7);
        assert.equal(extendSelection(4, f2, doc2.length).startLine, 0);
        assert.equal(extendSelection(4, f2, doc2.length).endLine, 7);
        assert.equal(extendSelection(5, f2, doc2.length).startLine, 0);
        assert.equal(extendSelection(5, f2, doc2.length).endLine, 7);
        assert.equal(extendSelection(6, f2, doc2.length).startLine, 6);
        assert.equal(extendSelection(6, f2, doc2.length).endLine, 6);
        assert.equal(extendSelection(7, f2, doc2.length).startLine, 0);
        assert.equal(extendSelection(7, f2, doc2.length).endLine, 7);
    });

    test("Selecting large RStudio comparison", () => {
        const doc = `
        if (TRUE) {              #  1. RStudio sends lines 1-17; vscode-R sends 1-17
                                 #  2. RStudio sends lines 2-4; vscode-R sends 2-4
          a = data.frame(x = 2,  #  3. RStudio sends lines 2-4; vscode-R sends 3-4
            y = 3)               #  4. RStudio sends lines 2-4; vscode-R sends 3-4
          print(                 #  5. RStudio sends lines 5-15; vscode-R sends 5-15
            a[                   #  6. RStudio sends lines 5-15; vscode-R sends 6-14
              if (TRUE) {        #  7. RStudio sends lines 7-13; vscode-R sends 7-13
                {                #  8. RStudio sends lines 8-12; vscode-R sends 8-12
                  (              #  9. RStudio sends lines 9-11; vscode-R sends 9-11
                    1            # 10. RStudio sends lines 9-11; vscode-R sends 10
                  )              # 11. RStudio sends lines 9-11; vscode-R sends 9-11
                }                # 12. RStudio sends lines 8-12; vscode-R sends 8-12
              }                  # 13. RStudio sends lines 5-15; vscode-R sends 7-13
              ]                  # 14. RStudio sends lines 5-15; vscode-R sends 6-14
          )                      # 15. RStudio sends lines 5-15; vscode-R sends 5-15
                                 # 16. RStudio sends lines 16-17; vscode-R sends 1-17
        }                        # 17. RStudio sends lines 1-17; vscode-R sends 1-17
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 17);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 4);
        assert.equal(extendSelection(3, f, doc.length).startLine, 2);
        assert.equal(extendSelection(3, f, doc.length).endLine, 4);
        assert.equal(extendSelection(4, f, doc.length).startLine, 2);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
        assert.equal(extendSelection(5, f, doc.length).startLine, 5);
        assert.equal(extendSelection(5, f, doc.length).endLine, 15);
        assert.equal(extendSelection(6, f, doc.length).startLine, 6);
        assert.equal(extendSelection(6, f, doc.length).endLine, 14);
        assert.equal(extendSelection(7, f, doc.length).startLine, 7);
        assert.equal(extendSelection(7, f, doc.length).endLine, 13);
        assert.equal(extendSelection(8, f, doc.length).startLine, 8);
        assert.equal(extendSelection(8, f, doc.length).endLine, 12);
        assert.equal(extendSelection(9, f, doc.length).startLine, 9);
        assert.equal(extendSelection(9, f, doc.length).endLine, 11);
        assert.equal(extendSelection(10, f, doc.length).startLine, 10);
        assert.equal(extendSelection(10, f, doc.length).endLine, 10);
        assert.equal(extendSelection(11, f, doc.length).startLine, 9);
        assert.equal(extendSelection(11, f, doc.length).endLine, 11);
        assert.equal(extendSelection(12, f, doc.length).startLine, 8);
        assert.equal(extendSelection(12, f, doc.length).endLine, 12);
        assert.equal(extendSelection(13, f, doc.length).startLine, 7);
        assert.equal(extendSelection(13, f, doc.length).endLine, 13);
        assert.equal(extendSelection(14, f, doc.length).startLine, 6);
        assert.equal(extendSelection(14, f, doc.length).endLine, 14);
        assert.equal(extendSelection(15, f, doc.length).startLine, 5);
        assert.equal(extendSelection(15, f, doc.length).endLine, 15);
        assert.equal(extendSelection(16, f, doc.length).startLine, 0);
        assert.equal(extendSelection(16, f, doc.length).endLine, 17);
        assert.equal(extendSelection(17, f, doc.length).startLine, 0);
        assert.equal(extendSelection(17, f, doc.length).endLine, 17);
    });

    test("Selecting block with missing opening bracket", () => {
        const doc = `
            1
        } %>%
            c(
                2
            )
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 1);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
        assert.equal(extendSelection(4, f, doc.length).startLine, 4);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
        assert.equal(extendSelection(5, f, doc.length).startLine, 5);
        assert.equal(extendSelection(5, f, doc.length).endLine, 5);
    });

    test("Selecting block with missing closing bracket", () => {
        const doc = `
            c(
                2
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 1);
        assert.equal(extendSelection(1, f, doc.length).endLine, 1);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting block with missing closing bracket and gap", () => {
        const doc = `
            c(
                2

        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 1);
        assert.equal(extendSelection(1, f, doc.length).endLine, 1);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 4);
    });

    test("Selecting block with missing opening bracket 2", () => {
        const doc = `
                2
            )
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 1);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting block with missing opening bracket and gap", () => {
        const doc = `

                2
            )
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
    });

    test("Selecting block with missing opening bracket and gap after", () => {
        const doc = `

                2
            )

        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 3);
        assert.equal(extendSelection(4, f, doc.length).startLine, 4);
        assert.equal(extendSelection(4, f, doc.length).endLine, 5);
    });

    test("Selecting longer badly-formed block", () => {
        const doc = `
        polys = SpatialPolygonsDataFrame(
            SpatialPolygons(list(
                Polygons(list(
                    Polygon(coords = rbind(c(0, 0)))
                ), ID = "1")),
                SpatialPolygons(list(
                    Polygons(list(
                        Polygon(coords = rbind(c(1,1)))
                    ), ID = "2"))
                )), data = data.frame(id = c(1,2))
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 1);
        assert.equal(extendSelection(1, f, doc.length).endLine, 1);
    });

    test("Selecting with comments", () => {
        const doc = `
            {
                1
                # }
            }
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 4);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 4);
        assert.equal(extendSelection(4, f, doc.length).startLine, 0);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
    });

    test("Selecting multi-line square bracket", () => {
        const doc = `
        a[1
            ]
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting ggplot plot", () => {
        const doc = `
        ggplot(aes(speed, dist), data = cars) +
            geom_point()
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 2);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 2);
    });

    test("Selecting multi-line bracket with pipe", () => {
        const doc = `
        list(x = 1,
            y = 2,
            z = 3) %>%
            print()
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 4);
        assert.equal(extendSelection(2, f, doc.length).startLine, 0);
        assert.equal(extendSelection(2, f, doc.length).endLine, 4);
        assert.equal(extendSelection(3, f, doc.length).startLine, 0);
        assert.equal(extendSelection(3, f, doc.length).endLine, 4);
        assert.equal(extendSelection(4, f, doc.length).startLine, 0);
        assert.equal(extendSelection(4, f, doc.length).endLine, 4);
    });

    test("Selecting shorter RStudio comparison", () => {
        const doc = `
        (                     # 1. RStudio and vscode-R send lines 1-9
            {                 # 2. RStudio and vscode-R send lines 2-8
                (             # 3. RStudio and vscode-R send lines 3-7
                    (         # 4. RStudio sends lines 3-7; vscode-R sends lines 4-6
                        1     # 5. RStudio sends lines 3-7; vscode-R sends line 5
                    )         # 6. RStudio sends lines 3-7; vscode-R sends lines 4-6
                )             # 7. RStudio and vscode-R send lines 3-7
            }                 # 8. RStudio sends lines 1-9; vscode-R sends lines 2-8
        )                     # 9. RStudio and vscode-R send lines 1-9
        `.split("\n");
        function f(i) {return (doc[i]); }
        assert.equal(extendSelection(1, f, doc.length).startLine, 0);
        assert.equal(extendSelection(1, f, doc.length).endLine, 9);
        assert.equal(extendSelection(2, f, doc.length).startLine, 2);
        assert.equal(extendSelection(2, f, doc.length).endLine, 8);
        assert.equal(extendSelection(3, f, doc.length).startLine, 3);
        assert.equal(extendSelection(3, f, doc.length).endLine, 7);
        assert.equal(extendSelection(4, f, doc.length).startLine, 4);
        assert.equal(extendSelection(4, f, doc.length).endLine, 6);
        assert.equal(extendSelection(5, f, doc.length).startLine, 5);
        assert.equal(extendSelection(5, f, doc.length).endLine, 5);
        assert.equal(extendSelection(6, f, doc.length).startLine, 4);
        assert.equal(extendSelection(6, f, doc.length).endLine, 6);
        assert.equal(extendSelection(7, f, doc.length).startLine, 3);
        assert.equal(extendSelection(7, f, doc.length).endLine, 7);
        assert.equal(extendSelection(8, f, doc.length).startLine, 2);
        assert.equal(extendSelection(8, f, doc.length).endLine, 8);
        assert.equal(extendSelection(9, f, doc.length).startLine, 0);
        assert.equal(extendSelection(9, f, doc.length).endLine, 9);
    });

});
