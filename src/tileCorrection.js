import {Point, toPoint} from 'leaflet/src/geometry/Point'
import {toLatLng} from 'leaflet/src/geo/LatLng'
import {Bounds} from 'leaflet/src/geometry/Bounds'

import {toLatLngBounds as latLngBounds} from 'leaflet/src/geo/LatLngBounds'
import * as DomUtil from 'leaflet/src/dom/DomUtil'
import Browser from 'leaflet/src/core/Browser'
import * as Util from 'leaflet/src/core/Util'

L.Map.include({
    project: function (latlng, zoom, crs) {
        zoom = zoom === undefined ? this._zoom : zoom
        return crs
            ? this.options.customCRS[crs].crs.latLngToPoint(toLatLng(latlng), zoom)
            : this.options.crs.latLngToPoint(toLatLng(latlng), zoom)
    },
    unproject: function (point, zoom, crs) {
        zoom = zoom === undefined ? this._zoom : zoom
        return crs
            ? this.options.customCRS[crs].crs.pointToLatLng(toPoint(point), zoom)
            : this.options.crs.pointToLatLng(toPoint(point), zoom)
    },
    getZoomScale: function (toZoom, fromZoom, crsName) {
        let crs = this.options.crs
        fromZoom = fromZoom === undefined ? this._zoom : fromZoom
        if (crsName) {
            toZoom -= this.options.customCRS[crsName].startZoom
            crs = this.options.customCRS[crsName].crs
            fromZoom =
                fromZoom || this._zoom - this.options.customCRS[crsName].startZoom
        }
        return crs.scale(toZoom) / crs.scale(fromZoom)
    },
    _getNewPixelOrigin: function (center, zoom, crs) {
        const viewHalf = this.getSize()._divideBy(2)
        return this.project(center, zoom, crs)
            ._subtract(viewHalf)
            ._add(this._getMapPanePos())
            ._round()
    },
    getPixelOrigin: function (crs) {
        this._checkIfLoaded()
        return crs ? this[crs] : this._pixelOrigin
    },
    _move: function (center, zoom, data) {
        if (zoom === undefined) {
            zoom = this._zoom
        }
        const zoomChanged = this._zoom !== zoom

        this._zoom = zoom
        this._lastCenter = center
        this._pixelOrigin = this._getNewPixelOrigin(center)

        const crss = Object.keys(this.options.customCRS)
        crss.forEach((crs) => {
            if (zoom >= this.options.customCRS[crs].startZoom) {
                const tileZoom = zoom - this.options.customCRS[crs].startZoom
                this[crs] = this._getNewPixelOrigin(center, tileZoom, crs)
            }
        })
        // @event zoom: Event
        // Fired repeatedly during any change in zoom level, including zoom
        // and fly animations.
        if (zoomChanged || (data && data.pinch)) {
            // Always fire 'zoom' if pinching because #3530
            this.fire('zoom', data)
        }

        // @event move: Event
        // Fired repeatedly during any movement of the map, including pan and
        // fly animations.
        return this.fire('move', data)
    }
})
L.GridLayer.include({
    _setView: function (center, zoom, noPrune, noUpdate) {
        let tileZoom = Math.round(zoom)
        if (
            (this.options.maxZoom !== undefined && tileZoom > this.options.maxZoom) ||
            (this.options.minZoom !== undefined && tileZoom < this.options.minZoom)
        ) {
            tileZoom = undefined
        } else {
            tileZoom = this._clampZoom(tileZoom)
        }
        if (this.options.customCRS && tileZoom) {
            if (zoom > this._map.options.customCRS[this.options.customCRS].startZoom) {
                tileZoom -= this._map.options.customCRS[this.options.customCRS].startZoom
            } else {
                tileZoom = undefined
            }
        }

        const tileZoomChanged =
            this.options.updateWhenZooming && tileZoom !== this._tileZoom

        if (!noUpdate || tileZoomChanged) {
            this._tileZoom = tileZoom

            if (this._abortLoading) {
                this._abortLoading()
            }

            this._updateLevels()
            this._resetGrid()

            if (tileZoom !== undefined) {
                this._update(center)
            }

            if (!noPrune) {
                this._pruneTiles()
            }

            // Flag to prevent _updateOpacity from pruning tiles during
            // a zoom anim or a pinch gesture
            this._noPrune = !!noPrune
        }

        this._setZoomTransforms(center, zoom)
    },
    _update: function (center) {
        const map = this._map
        if (!map) {
            return
        }

        if (center === undefined) {
            center = map.getCenter()
        }
        if (this._tileZoom === undefined) {
            return
        } // if out of minzoom/maxzoom

        const pixelBounds = this._getTiledPixelBounds(center)
        const tileRange = this._pxBoundsToTileRange(pixelBounds)
        const tileCenter = tileRange.getCenter()
        const queue = []
        const margin = this.options.keepBuffer
        const noPruneRange = new Bounds(
            tileRange.getBottomLeft().subtract([margin, -margin]),
            tileRange.getTopRight().add([margin, -margin])
        )

        // Sanity check: panic if the tile range contains Infinity somewhere.
        if (
            !(
                isFinite(tileRange.min.x) &&
                isFinite(tileRange.min.y) &&
                isFinite(tileRange.max.x) &&
                isFinite(tileRange.max.y)
            )
        ) {
            throw new Error('Attempted to load an infinite number of tiles')
        }

        for (const key in this._tiles) {
            const c = this._tiles[key].coords
            if (
                c.z !== this._tileZoom ||
                !noPruneRange.contains(new Point(c.x, c.y))
            ) {
                this._tiles[key].current = false
            }
        }

        // _update just loads more tiles. If the tile zoom level differs too much
        // from the map's, let _setView reset levels and prune old tiles.
        // if (Math.abs(zoom - this._tileZoom) > 1) { this._setView(center, zoom); return }

        // create a queue of coordinates to load tiles from
        for (let j = tileRange.min.y; j <= tileRange.max.y; j++) {
            for (let i = tileRange.min.x; i <= tileRange.max.x; i++) {
                const coords = new Point(i, j)
                coords.z = this._tileZoom

                if (!this._isValidTile(coords)) {
                    continue
                }

                const tile = this._tiles[this._tileCoordsToKey(coords)]
                if (tile) {
                    tile.current = true
                } else {
                    queue.push(coords)
                }
            }
        }

        // sort tile queue to load tiles in order of their distance to center
        queue.sort(function (a, b) {
            return a.distanceTo(tileCenter) - b.distanceTo(tileCenter)
        })

        if (queue.length !== 0) {
            // if it's the first batch of tiles to load
            if (!this._loading) {
                this._loading = true
                // @event loading: Event
                // Fired when the grid layer starts loading tiles.
                this.fire('loading')
            }

            // create DOM fragment to append tiles in one batch
            const fragment = document.createDocumentFragment()

            for (let i = 0; i < queue.length; i++) {
                this._addTile(queue[i], fragment)
            }

            this._level.el.appendChild(fragment)
        }
    },
    _updateLevels: function () {
        const zoom = this._tileZoom
        const maxZoom = this.options.maxZoom

        function remove(el) {
            const parent = el.parentNode
            if (parent) {
                parent.removeChild(el)
            }
        }

        if (zoom === undefined) {
            return undefined
        }

        for (let z in this._levels) {
            z = Number(z)
            if (this._levels[z].el.children.length || z === zoom) {
                this._levels[z].el.style.zIndex = maxZoom - Math.abs(zoom - z)
                this._onUpdateLevel(z)
            } else {
                remove(this._levels[z].el)
                this._removeTilesAtZoom(z)
                this._onRemoveLevel(z)
                delete this._levels[z]
            }
        }

        let level = this._levels[zoom]
        const map = this._map

        if (!level) {
            level = this._levels[zoom] = {}
            level.el = DomUtil.create(
                'div',
                'leaflet-tile-container leaflet-zoom-animated',
                this._container
            )
            level.el.style.zIndex = maxZoom
            level.origin = map
                .project(map.unproject(map.getPixelOrigin()), zoom)
                .round()
            if (this.options.customCRS) {
                const crs = this.options.customCRS
                level[crs] = map
                    .project(map.unproject(map.getPixelOrigin(crs), zoom, crs), zoom, crs)
                    .round()
            }
            level.zoom = zoom

            this._setZoomTransform(level, map.getCenter(), map.getZoom())

            // force the browser to consider the newly added element for transition
            Util.falseFn(level.el.offsetWidth)

            this._onCreateLevel(level)
        }

        this._level = level

        return level
    },
    _resetGrid: function () {
        const crs = (this.options.customCRS && this._map.options.customCRS[this.options.customCRS] && this._map.options.customCRS[this.options.customCRS].crs) || this._map.options.crs
        const tileSize = this._tileSize = this.getTileSize()
        const tileZoom = this._tileZoom

        const bounds = this._getPixelWorldBounds(this._tileZoom)
        if (bounds) {
            this._globalTileRange = this._pxBoundsToTileRange(bounds)
        }

        this._wrapX = crs.wrapLng && !this.options.noWrap && [
            Math.floor(this._map.project([0, crs.wrapLng[0]], tileZoom).x / tileSize.x),
            Math.ceil(this._map.project([0, crs.wrapLng[1]], tileZoom).x / tileSize.y)
        ]
        this._wrapY = crs.wrapLat && !this.options.noWrap && [
            Math.floor(this._map.project([crs.wrapLat[0], 0], tileZoom).y / tileSize.x),
            Math.ceil(this._map.project([crs.wrapLat[1], 0], tileZoom).y / tileSize.y)
        ]
    },
    _getPixelWorldBounds: function (zoom) {
        const crs = (this.options.customCRS && this._map.options.customCRS[this.options.customCRS] && this._map.options.customCRS[this.options.customCRS].crs) || this._map.options.crs
        return crs.getProjectedBounds(zoom === undefined ? this._map.getZoom() : zoom)
    },
    _getTiledPixelBounds: function (center) {
        const map = this._map
        const mapZoom = map._animatingZoom
            ? Math.max(map._animateToZoom, map.getZoom())
            : map.getZoom()
        const scale = map.getZoomScale(mapZoom, this._tileZoom, this.options.customCRS)
        const pixelCenter = map
            .project(center, this._tileZoom, this.options.customCRS)
            .floor()
        const halfSize = map.getSize().divideBy(scale * 2)

        return new Bounds(
            pixelCenter.subtract(halfSize),
            pixelCenter.add(halfSize)
        )
    },
    _getTilePos: function (coords) {
        const origin = this.options.customCRS
            ? this._level[this.options.customCRS]
            : this._level.origin
        return coords.scaleBy(this.getTileSize()).subtract(origin)
    },
    _isValidTile: function (coords) {
        let crs = this._map.options.crs
        if (this.options.customCRS) {
            crs = this._map.options.customCRS[this.options.customCRS].crs
        }
        if (!crs.infinite) {
            // don't load tile if it's out of bounds and not wrapped
            const bounds = this._globalTileRange
            if (
                (!crs.wrapLng &&
                    (coords.x < bounds.min.x || coords.x > bounds.max.x)) ||
                (!crs.wrapLat && (coords.y < bounds.min.y || coords.y > bounds.max.y))
            ) {
                return false
            }
        }

        if (!this.options.bounds) {
            return true
        }

        // don't load tile if it doesn't intersect the bounds in options
        const tileBounds = this._tileCoordsToBounds(coords)
        return latLngBounds(this.options.bounds).overlaps(tileBounds)
    },
    _setZoomTransform: function (level, center, zoom) {
        // zoom = this.options.minZoom ? zoom - this.options.minZoom : zoom
        const scale = this._map.getZoomScale(zoom, level.zoom, this.options.customCRS)
        const origin = this.options.customCRS ? level[this.options.customCRS] : level.origin
        const realZoom = this.options.customCRS
            ? zoom - this._map.options.customCRS[this.options.customCRS].startZoom
            : zoom
        const translate = origin
            .multiplyBy(scale)
            .subtract(this._map._getNewPixelOrigin(center, realZoom, this.options.customCRS))
            .round()
        if (Browser.any3d) {
            DomUtil.setTransform(level.el, translate, scale)
        } else {
            DomUtil.setPosition(level.el, translate)
        }
    }
})
