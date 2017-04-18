const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLInt,
  GraphQLEnumType,
} = require("graphql")
const Remark = require("remark")
const select = require("unist-util-select")
const sanitizeHTML = require("sanitize-html")
const _ = require("lodash")
const path = require("path")
const fs = require("fs")
const fsExtra = require("fs-extra")
const querystring = require("querystring")
const visit = require("unist-util-visit")
const Prism = require("prismjs")
require("prismjs/components/prism-go")
const toHAST = require("mdast-util-to-hast")
const hastToHTML = require("hast-util-to-html")
const inspect = require("unist-util-inspect")
const Promise = require("bluebird")
const prune = require("underscore.string/prune")

const astPromiseCache = {}

// Delete Markdown AST cache when the node is recreated
// e.g. the user saves a change to the file.
exports.onNodeCreate = ({ node }) => {
  if (node.type === `MarkdownRemark`) {
    delete astPromiseCache[node.id]
  }
}

exports.extendNodeType = (
  { type, allNodes, linkPrefix, getNode },
  pluginOptions
) => {
  if (type.name !== `MarkdownRemark`) {
    return {}
  }

  return new Promise((resolve, reject) => {
    const files = allNodes.filter(n => n.type === `File`)

    // Setup Remark.
    const remark = new Remark({
      commonmark: true,
      footnotes: true,
      pedantic: true,
    })

    async function getAST(markdownNode) {
      if (astPromiseCache[markdownNode.id]) {
        return astPromiseCache[markdownNode.id]
      } else {
        astPromiseCache[markdownNode.id] = new Promise((resolve, reject) => {
          Promise.all(
            pluginOptions.plugins.map(plugin => {
              const requiredPlugin = require(plugin.resolve)
              if (_.isFunction(requiredPlugin.mutateSource)) {
                console.log(`running plugin to mutate markdown source`)
                return requiredPlugin.mutateSource({
                  markdownNode,
                  files,
                  getNode,
                  pluginOptions: plugin.pluginOptions,
                })
              } else {
                return Promise.resolve()
              }
            })
          ).then(() => {
            const markdownAST = remark.parse(markdownNode.src)

            // source => parse (can order parsing for dependencies) => typegen
            //
            // source plugins identify nodes, provide id, initial parse, know
            // when nodes are created/removed/deleted
            // get passed cached DataTree and return list of clean and dirty nodes.
            // Also get passed `dirtyNodes` function which they can call with an array
            // of node ids which will then get re-parsed and the inferred schema
            // recreated (if inferring schema gets too expensive, can also
            // cache the schema until a query fails at which point recreate the
            // schema).
            //
            // parse plugins take data from source nodes and extend it, never mutate
            // it. Freeze all nodes once done so typegen plugins can't change it
            // this lets us save off the DataTree at that point as well as create
            // indexes.
            //
            // typegen plugins identify further types of data that should be lazily
            // computed due to their expense, or are hard to infer graphql type
            // (markdown ast), or are need user input in order to derive e.g.
            // markdown headers or date fields.
            //
            // wrap all resolve functions to (a) auto-memoize and (b) cache to disk any
            // resolve function that takes longer than ~10ms (do research on this
            // e.g. how long reading/writing to cache takes), and (c) track which
            // queries are based on which source nodes. Also if connection of what
            // which are always rerun if their underlying nodes change..
            //
            // every node type in DataTree gets a schema type automatically.
            // typegen plugins just modify the auto-generated types to add derived fields
            // as well as computationally expensive fields.
            Promise.all(
              pluginOptions.plugins.map(plugin => {
                const requiredPlugin = require(plugin.resolve)
                if (_.isFunction(requiredPlugin)) {
                  return requiredPlugin({
                    markdownAST,
                    markdownNode,
                    getNode,
                    files,
                    pluginOptions: plugin.pluginOptions,
                    linkPrefix,
                  })
                } else {
                  return Promise.resolve()
                }
              })
            ).then(() => {
              markdownNode.ast = markdownAST
              resolve(markdownNode)
            })
          })
        })
      }

      return astPromiseCache[markdownNode.id]
    }

    async function getHeadings(markdownNode) {
      if (markdownNode.headings) {
        return markdownNode
      } else {
        const { ast } = await getAST(markdownNode)
        markdownNode.headings = select(ast, `heading`).map(heading => ({
          value: _.first(select(heading, `text`).map(text => text.value)),
          depth: heading.depth,
        }))

        return markdownNode
      }
    }

    const htmlPromisesCache = {}
    async function getHTML(markdownNode) {
      if (htmlPromisesCache[markdownNode.id]) {
        return htmlPromisesCache[markdownNode.id]
      } else {
        htmlPromisesCache[markdownNode.id] = new Promise((resolve, reject) => {
          getAST(markdownNode).then(node => {
            node.html = hastToHTML(
              toHAST(node.ast, { allowDangerousHTML: true }),
              { allowDangerousHTML: true }
            )
            return resolve(node)
          })
        })
        return htmlPromisesCache[markdownNode.id]
      }
    }

    const HeadingType = new GraphQLObjectType({
      name: `MarkdownHeading`,
      fields: {
        value: {
          type: GraphQLString,
          resolve(heading) {
            return heading.value
          },
        },
        depth: {
          type: GraphQLInt,
          resolve(heading) {
            return heading.depth
          },
        },
      },
    })

    const HeadingLevels = new GraphQLEnumType({
      name: "HeadingLevels",
      values: {
        h1: { value: 1 },
        h2: { value: 2 },
        h3: { value: 3 },
        h4: { value: 4 },
        h5: { value: 5 },
        h6: { value: 6 },
      },
    })

    return resolve({
      html: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getHTML(markdownNode).then(node => node.html)
        },
      },
      src: {
        type: GraphQLString,
      },
      excerpt: {
        type: GraphQLString,
        args: {
          pruneLength: {
            type: GraphQLInt,
            defaultValue: 140,
          },
        },
        resolve(markdownNode, { pruneLength }) {
          return getAST(markdownNode).then(node => {
            const textNodes = []
            visit(node.ast, `text`, textNode => textNodes.push(textNode.value))
            return prune(textNodes.join(` `), pruneLength)
          })
        },
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: {
            type: HeadingLevels,
          },
        },
        resolve(markdownNode, { depth }) {
          return getHeadings(markdownNode).then(node => {
            let headings = node.headings
            if (typeof depth === "number") {
              headings = headings.filter(heading => heading.depth === depth)
            }
            return headings
          })
        },
      },
      timeToRead: {
        type: GraphQLInt,
        resolve(markdownNode) {
          return getHTML(markdownNode).then(node => {
            let timeToRead = 0
            const pureText = sanitizeHTML(node.html, { allowTags: [] })
            const avgWPM = 265
            const wordCount = _.words(pureText).length
            timeToRead = Math.round(wordCount / avgWPM)
            if (timeToRead === 0) {
              timeToRead = 1
            }
            return timeToRead
          })
        },
      },
    })
  })
}